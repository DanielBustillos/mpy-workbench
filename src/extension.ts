
import * as vscode from "vscode";
import { Esp32Tree } from "./esp32Fs";
import { ActionsTree } from "./actions";
import { SyncTree } from "./syncView";
import { LocalFilesTree, LocalFileNode } from "./localFilesView";
import { Esp32Node } from "./types";
import * as mp from "./mpremote";
import { refreshFileTreeCache, debugTreeParsing, debugFilesystemStatus, runMpremote } from "./mpremote";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { buildManifest, diffManifests, saveManifest, loadManifest, defaultIgnorePatterns, createIgnoreMatcher, createEmptyManifest, Manifest, entryKind, isSymlink } from "./sync";
import { Esp32DecorationProvider } from "./decorations";
import { listDirPyRaw } from "./pyraw";
import {
  disconnectReplTerminal,
  restartReplInExistingTerminal,
  checkMpremoteAvailability,
  serialSendCtrlC,
  stop,
  softReset,
  runActiveFile,
  getReplTerminal,
  isReplOpen,
  closeReplTerminal,
  openReplTerminal,
  toLocalRelative,
  toDevicePath,
  getSyncRoot,
  clearRunFileTerminalIf
} from "./mpremoteCommands";
import { clearPythonCache } from "./pythonInterpreter";
import { log } from "./logger";
import { syncRelative } from "./syncRoot";

export function activate(context: vscode.ExtensionContext) {
  // Check if mpremote is available
  checkMpremoteAvailability().catch(() => {});
  // Helper to get workspace folder or throw error
  function getWorkspaceFolder(): vscode.WorkspaceFolder {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) throw new Error("No workspace folder open");
    return ws;
  }

  // Helper to get default ignore patterns as Set for compatibility
  function getDefaultIgnoreSet(): Set<string> {
    return new Set(defaultIgnorePatterns());
  }

  // Helper to validate if the local folder is initialized
  async function isLocalSyncInitialized(): Promise<boolean> {
    try {
      const ws = getWorkspaceFolder();
  const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
      await fs.access(manifestPath);
      return true;
    } catch {
      return false;
    }
  }
  
  // Helper for delays in retry logic
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Workspace-level config and manifest stored in .mpy-workbench/
  const MPY_WORKBENCH_DIR = '.mpy-workbench';
  const MPY_CONFIG_FILE = 'config.json';
  const MPY_MANIFEST_FILE = 'esp32sync.json';

  async function ensureMpyWorkbenchDir(wsPath: string) {
    try {
      await fs.mkdir(path.join(wsPath, MPY_WORKBENCH_DIR), { recursive: true });
    } catch { /* ignore */ }
  }

  async function ensureWorkbenchIgnoreFile(wsPath: string) {
    try {
      await ensureMpyWorkbenchDir(wsPath);
      const p = path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore');
      await fs.access(p);
    } catch {
      const content = buildDefaultMpyIgnoreContent();
      try { await fs.writeFile(path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore'), content, 'utf8'); } catch {}
    }
  }

  function buildDefaultMpyIgnoreContent(): string {
    return [
      '# .mpyignore — default rules (similar to .gitignore). Adjust according to your project.',
      '# Paths are relative to the workspace root.',
      '',
      '# VCS',
      '.git/',
      '.svn/',
      '.hg/',
      '',
      '# IDE/Editor',
      '.vscode/',
      '.idea/',
      '.vs/',
      '',
      '# SO',
      '.DS_Store',
      'Thumbs.db',
      '',
      '# Node/JS',
      'node_modules/',
      'dist/',
      'out/',
      'build/',
      '.cache/',
      'coverage/',
      '.next/',
      '.nuxt/',
      '.svelte-kit/',
      '.turbo/',
      '.parcel-cache/',
      '*.log',
      'npm-debug.log*',
      'yarn-debug.log*',
      'yarn-error.log*',
      'pnpm-debug.log*',
      '',
      '# Python',
      '__pycache__/',
      '*.py[cod]',
      '*.pyo',
      '*.pyd',
      '.venv/',
      'venv/',
      '.env',
      '.env.*',
      '.mypy_cache/',
      '.pytest_cache/',
      '.coverage',
      'coverage.xml',
      '*.egg-info/',
      '.tox/',
      '',
      '# Otros',
      '*.swp',
      '*.swo',
      '',
      '# MPY Workbench',
      '.mpy-workbench/',
      '/.mpy-workbench',
      ''
    ].join('\n');
  }


  async function readWorkspaceConfig(wsPath: string): Promise<any> {
    try {
      const p = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
      const txt = await fs.readFile(p, 'utf8');
      return JSON.parse(txt);
    } catch {
      return {};
    }
  }

  async function writeWorkspaceConfig(wsPath: string, obj: any) {
    try {
      await ensureMpyWorkbenchDir(wsPath);
      const p = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
      await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      log.error('Failed to write .mpy-workbench config', e);
    }
  }

  // Returns true if autosync should run for this workspace (per-workspace override file wins, otherwise global setting)
  async function workspaceAutoSyncEnabled(wsPath: string): Promise<boolean> {
    const cfg = await readWorkspaceConfig(wsPath);
    if (typeof cfg.autoSyncOnSave === 'boolean') return cfg.autoSyncOnSave;
    return vscode.workspace.getConfiguration().get<boolean>('mpyWorkbench.autoSyncOnSave', false);
  }

  // Context key for welcome UI when no port is selected
  const updatePortContext = () => {
    const v = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    const has = !!v && v !== "auto";
    vscode.commands.executeCommand('setContext', 'mpyWorkbench.hasPort', has);
  };
  // Ensure no port is selected at startup
  vscode.workspace.getConfiguration().update("mpyWorkbench.connect", "auto", vscode.ConfigurationTarget.Global);
  updatePortContext();

  const tree = new Esp32Tree();
  const view = vscode.window.createTreeView("mpyWorkbenchFsView", { treeDataProvider: tree });
  const actionsTree = new ActionsTree();
  const actionsView = vscode.window.createTreeView("mpyWorkbenchActionsView", { treeDataProvider: actionsTree });
  const syncTree = new SyncTree();
  const syncView = vscode.window.createTreeView("mpyWorkbenchSyncView", { treeDataProvider: syncTree });
  const localFilesTree = new LocalFilesTree();
  const localFilesView = vscode.window.createTreeView("mpyWorkbenchLocalFilesView", { treeDataProvider: localFilesTree });
  const decorations = new Esp32DecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
  // Export decorations for use in other modules
  (global as any).esp32Decorations = decorations;

  let lastLocalOnlyNotice = 0;

  // Status bar item to show workspace auto-sync state
  const autoSyncStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  autoSyncStatus.command = 'mpyWorkbench.toggleWorkspaceAutoSync';
  autoSyncStatus.tooltip = 'Toggle workspace Auto-Sync on Save';
  context.subscriptions.push(autoSyncStatus);

  // Status bar item for canceling all tasks
  const cancelTasksStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  cancelTasksStatus.command = 'mpyWorkbench.cancelAllTasks';
  cancelTasksStatus.tooltip = 'Cancel all running tasks';
  cancelTasksStatus.text = 'MPY: Cancel';
  cancelTasksStatus.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  context.subscriptions.push(cancelTasksStatus);

  async function refreshAutoSyncStatus() {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        autoSyncStatus.hide();
        cancelTasksStatus.hide();
        return;
      }
      if (!(await isLocalSyncInitialized())) {
        autoSyncStatus.hide();
        cancelTasksStatus.hide();
        return;
      }
      const enabled = await workspaceAutoSyncEnabled(ws.uri.fsPath);
      autoSyncStatus.text = enabled ? 'MPY: AutoSync ON' : 'MPY: AutoSync OFF';
      autoSyncStatus.color = enabled ? undefined : new vscode.ThemeColor('statusBarItem.warningForeground');
      autoSyncStatus.show();
      cancelTasksStatus.show();
    } catch (e) {
      autoSyncStatus.hide();
      cancelTasksStatus.hide();
    }
  }

  // Watch for workspace config changes in .mpystudio/config.json to update the status
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const wsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const cfgGlob = new vscode.RelativePattern(wsPath, '.mpystudio/config.json');
    const watcher = vscode.workspace.createFileSystemWatcher(cfgGlob);
    watcher.onDidChange(refreshAutoSyncStatus);
    watcher.onDidCreate(refreshAutoSyncStatus);
    watcher.onDidDelete(refreshAutoSyncStatus);
    context.subscriptions.push(watcher);
    const manifestGlob = new vscode.RelativePattern(wsPath, `${MPY_WORKBENCH_DIR}/${MPY_MANIFEST_FILE}`);
    const manifestWatcher = vscode.workspace.createFileSystemWatcher(manifestGlob);
    manifestWatcher.onDidCreate(refreshAutoSyncStatus);
    manifestWatcher.onDidChange(refreshAutoSyncStatus);
    manifestWatcher.onDidDelete(refreshAutoSyncStatus);
    context.subscriptions.push(manifestWatcher);
  }

  // Initialize status bar on activation
  refreshAutoSyncStatus();

  let opQueue: Promise<any> = Promise.resolve();
  let listingInProgress = false;
  let skipIdleOnce = false;
  function setSkipIdleOnce() { skipIdleOnce = true; }
  async function ensureIdle(): Promise<void> {
    // Keep this lightweight: do not chain kill/ctrl-c automatically.
    // Optionally perform a quick check to nudge the connection.
    try { await mp.ls("/"); } catch {}
    if (listingInProgress) {
      const d = vscode.workspace.getConfiguration().get<number>("mpyWorkbench.preListDelayMs", 150);
      if (d > 0) await new Promise(r => setTimeout(r, d));
    }
  }
  async function withAutoSuspend<T>(fn: () => Promise<T>, opts: { preempt?: boolean } = {}): Promise<T> {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("mpyWorkbench.serialAutoSuspend", true);
    // Optionally preempt any in-flight mpremote process so new command takes priority
    if (opts.preempt !== false) {
      opQueue = Promise.resolve();
    }
    // If auto-suspend disabled or explicitly skipping for this view action, run without ensureIdle/REPL juggling
    if (!enabled || skipIdleOnce) {
      skipIdleOnce = false;
      try { return await fn(); }
      finally { }
    }
    opQueue = opQueue.catch(() => {}).then(async () => {
      const wasOpen = isReplOpen();
      if (wasOpen) await disconnectReplTerminal();
      try {
        await ensureIdle();
        return await fn();
      } finally {
        if (wasOpen) await restartReplInExistingTerminal();
      }
    });
    return opQueue as Promise<T>;
  }

  /** Reject empty names, trailing slashes and any ".." segment (would escape the workspace). */
  function validateRelativeName(v: string): string | undefined {
    if (!v || !v.trim()) return "Name cannot be empty";
    if (/[\\/]$/.test(v)) return "Name must not end with / or \\";
    if (v.split(/[\\/]/).some(seg => seg === "..")) return "Name must not contain '..'";
    return undefined;
  }

  function normalizeRelativeName(v: string): string {
    return v.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  }

  /** Absolute local path that mirrors a board path, honoring mpyWorkbench.rootPath. */
  function deviceToLocalAbs(devicePath: string): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
    const rel = toLocalRelative(devicePath, rootPath);
    return path.join(getSyncRoot(ws), ...rel.split("/").filter(Boolean));
  }

  /** True if `rel` (relative to `root`) or any of its parent folders is a symlink. */
  async function pathHasSymlink(root: string, rel: string): Promise<boolean> {
    let current = root;
    for (const part of rel.split("/").filter(Boolean)) {
      current = path.join(current, part);
      if (await isSymlink(current)) return true;
    }
    return false;
  }

  /** Delete a board file/folder with a progress notification. Returns true on success. */
  async function deleteFromBoardWithProgress(node: Esp32Node): Promise<boolean> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Deleting ${node.path}...`,
      cancellable: false
    }, async () => {
      try {
        await withAutoSuspend(() => mp.deleteAny(node.path));
        tree.removeNode(node.path);
        vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
        return true;
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
        return false;
      }
    });
  }

  async function uploadLocalFolderToDevice(localDirPath: string, deviceBasePath: string): Promise<void> {
    const folderName = path.basename(localDirPath);
    const deviceDirPath = deviceBasePath === "/" || !deviceBasePath
      ? `/${folderName}`
      : `${deviceBasePath.replace(/\/$/, "")}/${folderName}`;
    try {
      await withAutoSuspend(() => mp.mkdir(deviceDirPath));
    } catch (err: any) {
      const msg = String(err?.message ?? err).toLowerCase();
      if (!msg.includes("file exists") && !msg.includes("directory exists")) throw err;
    }
    tree.addNode(deviceDirPath, true);
    const entries = await fs.readdir(localDirPath, { withFileTypes: true });
    for (const e of entries) {
      const entryAbs = path.join(localDirPath, e.name);
      const deviceChildPath = deviceDirPath === "/" ? `/${e.name}` : `${deviceDirPath}/${e.name}`;
      const kind = await entryKind(entryAbs, e); // follows symlinks (#34)
      if (kind === "dir") {
        await uploadLocalFolderToDevice(entryAbs, deviceDirPath);
      } else if (kind === "file") {
        await withAutoSuspend(() => mp.cpToDevice(entryAbs, deviceChildPath));
        tree.addNode(deviceChildPath, false);
      }
    }
  }

  context.subscriptions.push(
    view,
    actionsView,
    syncView,
    localFilesView,
    vscode.commands.registerCommand("mpyWorkbench.showLog", () => log.show()),
    // Workspace settings become effective once the folder is trusted
    vscode.workspace.onDidGrantWorkspaceTrust(() => clearPythonCache()),
    vscode.commands.registerCommand("mpyWorkbench.refresh", () => {
      // Clear cache and force next listing to come from device
      tree.clearCache();
      tree.enableRawListForNext();
      tree.refreshTree();
    }),
    vscode.commands.registerCommand("mpyWorkbench.refreshFileTreeCache", async () => {
      try {
        log.debug("Starting manual file tree cache refresh...");
        await mp.refreshFileTreeCache();
        log.debug("File tree cache refresh completed");
        vscode.window.showInformationMessage("File tree cache refreshed successfully");
      } catch (error: any) {
        log.error("File tree cache refresh failed:", error);
        vscode.window.showErrorMessage(`File tree cache refresh failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.initializeWorkspace", async () => {
      try {
        const ws = getWorkspaceFolder();
        const initialized = await isLocalSyncInitialized();
        if (initialized) {
          const choice = await vscode.window.showWarningMessage(
            "De-initialize will remove the .mpy-workbench folder and sync state. Continue?",
            { modal: true },
            "De-initialize",
            "Cancel"
          );
          if (choice !== "De-initialize") return;
          await fs.rm(path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR), { recursive: true, force: true });
          vscode.window.showInformationMessage("Workspace de-initialized.");
          await refreshAutoSyncStatus();
          syncTree.refreshTree();
          return;
        }
        await ensureMpyWorkbenchDir(ws.uri.fsPath);
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
        const emptyManifest = createEmptyManifest(getSyncRoot(ws));
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, emptyManifest);
        vscode.window.showInformationMessage("Workspace initialized for MPY Workbench.");
        await refreshAutoSyncStatus();
        syncTree.refreshTree();
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message || "Failed to initialize workspace");
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.rebuildManifest", async () => {
      try {
        log.debug("Starting manual manifest rebuild...");
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
          vscode.window.showErrorMessage("No workspace folder open");
          return;
        }
        const initialized = await isLocalSyncInitialized();
        if (!initialized) {
          vscode.window.showWarningMessage("Workspace not initialized. Run **MPY Workbench: Initialize Workspace** first.");
          return;
        }

        // Ensure directories exist
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);

        // Rebuild manifest
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const newManifest = await buildManifest(getSyncRoot(ws), matcher);
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, newManifest);

        log.debug("Manifest rebuild completed");
        vscode.window.showInformationMessage(`Manifest rebuilt successfully (${Object.keys(newManifest.files).length} files)`);
      } catch (error: any) {
        log.error("Manifest rebuild failed:", error);
        vscode.window.showErrorMessage(`Manifest rebuild failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.debugTreeParsing", async () => {
      try {
        log.debug("Starting tree parsing debug...");
        await debugTreeParsing();
        log.debug("Tree parsing debug completed");
        vscode.window.showInformationMessage("Tree parsing debug completed - check console for details");
      } catch (error: any) {
        log.error("Tree parsing debug failed:", error);
        vscode.window.showErrorMessage(`Tree parsing debug failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.debugFilesystemStatus", async () => {
      try {
        log.debug("Starting filesystem status debug...");
        await debugFilesystemStatus();
        log.debug("Filesystem status debug completed");
        vscode.window.showInformationMessage("Filesystem status debug completed - check console for details");
      } catch (error: any) {
        log.error("Filesystem status debug failed:", error);
        vscode.window.showErrorMessage(`Filesystem status debug failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.cancelAllTasks", async () => {
      try {
        log.debug("Canceling all tasks...");

        // Cancel current mpremote process
        mp.cancelAll();

        // Clear the operation queue by resetting it
        opQueue = Promise.resolve();

        vscode.window.showInformationMessage("All tasks have been canceled");
        log.debug("All tasks canceled successfully");
      } catch (error: any) {
        log.error("Failed to cancel tasks:", error);
        vscode.window.showErrorMessage(`Failed to cancel tasks: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.pickPort", async () => {
      // Always get the most recent port list before showing the selector
      const devices = await mp.listSerialPorts();
      const items: vscode.QuickPickItem[] = [
        { label: "auto", description: "Auto-detect device" },
        ...devices.map(d => ({ label: d.port, description: d.name || "serial port" }))
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select Board serial port" });
      if (!picked) return;
      const value = picked.label === "auto" ? "auto" : picked.label;
   await vscode.workspace.getConfiguration().update("mpyWorkbench.connect", value, vscode.ConfigurationTarget.Global);
   updatePortContext();
   vscode.window.showInformationMessage(`Board connect set to ${value}`);
   tree.clearCache();
   tree.refreshTree();
   // (no prompt) just refresh the tree after selecting port
    }),
    vscode.commands.registerCommand("mpyWorkbench.serialSendCtrlC", serialSendCtrlC),
    vscode.commands.registerCommand("mpyWorkbench.stop", stop),
    vscode.commands.registerCommand("mpyWorkbench.softReset", softReset),

    vscode.commands.registerCommand("mpyWorkbench.uploadToBoard", async (node: LocalFileNode) => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const relToSync = syncRelative(getSyncRoot(ws), node.fsPath);
      if (!relToSync) {
        vscode.window.showWarningMessage(`${node.relPath} is outside mpyWorkbench.localRoot, so it has no place on the board.`);
        return;
      }
      const devicePath = toDevicePath(relToSync, rootPath);
      try {
        if (node.kind === "file") {
          await withAutoSuspend(() => mp.cpToDevice(node.fsPath, devicePath));
          tree.addNode(devicePath, false);
          vscode.window.showInformationMessage(`Uploaded to board: ${node.relPath}`);
        } else {
          const deviceParent = path.posix.dirname(devicePath);
          await uploadLocalFolderToDevice(node.fsPath, deviceParent);
          vscode.window.showInformationMessage(`Uploaded folder to board: ${node.relPath}`);
        }
        tree.refreshTree();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Upload failed: ${err?.message ?? String(err)}`);
      }
    }),

    vscode.commands.registerCommand("mpyWorkbench.localOpen", async (node: LocalFileNode) => {
      const uri = vscode.Uri.file(node.fsPath);
      if (node.kind === "file") {
        await vscode.commands.executeCommand("vscode.open", uri);
      } else {
        await vscode.commands.executeCommand("revealFileInOS", uri);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.localCut", async (node: LocalFileNode) => {
      await vscode.commands.executeCommand("filesExplorer.cut", vscode.Uri.file(node.fsPath));
    }),
    vscode.commands.registerCommand("mpyWorkbench.localCopy", async (node: LocalFileNode) => {
      await vscode.commands.executeCommand("filesExplorer.copy", vscode.Uri.file(node.fsPath));
    }),
    vscode.commands.registerCommand("mpyWorkbench.localCopyPath", async (node: LocalFileNode) => {
      await vscode.env.clipboard.writeText(node.fsPath);
    }),
    vscode.commands.registerCommand("mpyWorkbench.localCopyRelativePath", async (node: LocalFileNode) => {
      await vscode.env.clipboard.writeText(node.relPath);
    }),
    vscode.commands.registerCommand("mpyWorkbench.localRename", async (node: LocalFileNode) => {
      const uri = vscode.Uri.file(node.fsPath);
      const newName = await vscode.window.showInputBox({
        prompt: "New name",
        value: node.name,
        validateInput: (v) => (!v || v.includes("/") || v.includes("\\") ? "Invalid name" : undefined),
      });
      if (!newName || newName === node.name) return;
      const parentPath = path.dirname(node.fsPath);
      const newPath = path.join(parentPath, newName);
      const newUri = vscode.Uri.file(newPath);
      try {
        await vscode.workspace.fs.rename(uri, newUri, { overwrite: false });
        localFilesTree.refreshTree();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Rename failed: ${err?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.localDelete", async (node: LocalFileNode) => {
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${node.name}?`,
        { modal: true },
        "Delete",
        "Cancel"
      );
      if (confirm !== "Delete") return;
      const uri = vscode.Uri.file(node.fsPath);
      try {
        await vscode.workspace.fs.delete(uri, { recursive: node.kind === "dir", useTrash: true });
        localFilesTree.refreshTree();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Delete failed: ${err?.message ?? String(err)}`);
      }
    }),

    vscode.commands.registerCommand("mpyWorkbench.setPort", async (port: string) => {
  await vscode.workspace.getConfiguration().update("mpyWorkbench.connect", port, vscode.ConfigurationTarget.Global);
  updatePortContext();
  vscode.window.showInformationMessage(`ESP32 connect set to ${port}`);
  tree.clearCache();
  tree.refreshTree();
  // (no prompt) just refresh the tree after setting port
    }),

    vscode.commands.registerCommand("mpyWorkbench.syncBaseline", async () => {
      try {
        // Close the REPL terminal if open to avoid port conflicts
        if (isReplOpen()) {
          await disconnectReplTerminal();
          await new Promise(r => setTimeout(r, 400));
        }
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
        const initialized = await isLocalSyncInitialized();
        if (!initialized) {
          vscode.window.showWarningMessage("Workspace not initialized. Run **MPY Workbench: Initialize Workspace** first.");
          return;
        }

        const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
        const matcher2 = await createIgnoreMatcher(ws.uri.fsPath);
        const syncRoot = getSyncRoot(ws);
        const man = await buildManifest(syncRoot, matcher2);

        // Upload all files with progress using single mpremote fs cp command
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Uploading all files to board...",
          cancellable: false
        }, async (progress, token) => {
          const files = Object.keys(man.files);
          const total = files.length;

          if (total === 0) {
            progress.report({ increment: 100, message: "No files to upload" });
            return;
          }

          progress.report({ increment: 0, message: `Found ${total} files to upload` });

          await withAutoSuspend(async () => {
            // First, create all necessary directories on the device in hierarchical order
            progress.report({ increment: 5, message: "Creating directories on device..." });

            // Collect all unique directory paths that need to be created
            const allDirectories = new Set<string>();
            for (const relativePath of files) {
              const devicePath = path.posix.join(rootPath, relativePath);
              const deviceDir = path.posix.dirname(devicePath);

              if (deviceDir !== '.' && deviceDir !== rootPath) {
                // Add all parent directories to the set
                let currentDir = deviceDir;
                while (currentDir !== rootPath && currentDir !== '/') {
                  allDirectories.add(currentDir);
                  currentDir = path.posix.dirname(currentDir);
                }
              }
            }

            // Sort directories by depth (shallowest first) to ensure parent directories are created before children
            const sortedDirectories = Array.from(allDirectories).sort((a, b) => {
              const depthA = a.split('/').filter(p => p).length;
              const depthB = b.split('/').filter(p => p).length;
              return depthA - depthB;
            });

            log.debug(`syncBaseline: Need to create ${sortedDirectories.length} directories:`, sortedDirectories);

            // Create directories in hierarchical order with retry logic
            let createdCount = 0;
            let failedDirectories: string[] = [];

            log.debug(`syncBaseline: Starting directory creation for ${sortedDirectories.length} directories...`);

            for (const deviceDir of sortedDirectories) {
              let created = false;
              let attempts = 0;
              const maxAttempts = 3;

              while (!created && attempts < maxAttempts) {
                attempts++;
                try {
                  log.debug(`syncBaseline: Creating directory ${deviceDir} (attempt ${attempts}/${maxAttempts})`);
                  await mp.mkdir(deviceDir);
                  tree.addNode(deviceDir, true); // Add folder to tree
                  created = true;
                  createdCount++;
                  log.debug(`syncBaseline: ✓ Created directory ${deviceDir} (${createdCount}/${sortedDirectories.length})`);
                } catch (error: any) {
                  log.debug(`syncBaseline: ✗ Directory ${deviceDir} creation failed (attempt ${attempts}):`, error.message);

                  if (attempts >= maxAttempts) {
                    failedDirectories.push(deviceDir);
                    log.error(`syncBaseline: ✗✗ Giving up on directory ${deviceDir} after ${maxAttempts} attempts`);
                  } else {
                    // Wait a bit before retrying
                    await new Promise(resolve => setTimeout(resolve, 100));
                  }
                }
              }
            }

            log.debug(`syncBaseline: Directory creation completed. Created ${createdCount} out of ${sortedDirectories.length} directories.`);

            if (failedDirectories.length > 0) {
              log.error(`syncBaseline: Failed to create ${failedDirectories.length} directories:`, failedDirectories);
            }

            // Verify that ALL directories exist before proceeding with bulk upload
            log.debug(`syncBaseline: Verifying ALL directories exist before bulk upload...`);
            let allDirectoriesExist = true;
            const verificationFailures: string[] = [];

            for (const deviceDir of sortedDirectories) {
              try {
                const exists = await mp.fileExists(deviceDir);
                if (!exists) {
                  log.error(`syncBaseline: ✗ Directory ${deviceDir} does not exist!`);
                  verificationFailures.push(deviceDir);
                  allDirectoriesExist = false;
                } else {
                  log.debug(`syncBaseline: ✓ Directory ${deviceDir} verified`);
                }
              } catch (error: any) {
                log.error(`syncBaseline: ✗ Error checking directory ${deviceDir}:`, error.message);
                verificationFailures.push(deviceDir);
                allDirectoriesExist = false;
              }
            }

            if (!allDirectoriesExist) {
              log.error(`syncBaseline: Cannot proceed with bulk upload - ${verificationFailures.length} directories missing:`, verificationFailures);

              // Try to create the missing directories one more time
              log.debug(`syncBaseline: Attempting to create missing directories...`);
              for (const missingDir of verificationFailures) {
                try {
                  log.debug(`syncBaseline: Creating missing directory: ${missingDir}`);
                  await mp.mkdir(missingDir);
                  tree.addNode(missingDir, true);
                  log.debug(`syncBaseline: ✓ Successfully created missing directory: ${missingDir}`);
                } catch (createError: any) {
                  log.error(`syncBaseline: ✗ Failed to create missing directory ${missingDir}:`, createError.message);
                }
              }

              // Verify again after the retry
              log.debug(`syncBaseline: Re-verifying directories after retry...`);
              let stillMissing = [];
              for (const missingDir of verificationFailures) {
                try {
                  const exists = await mp.fileExists(missingDir);
                  if (!exists) {
                    stillMissing.push(missingDir);
                  }
                } catch (error: any) {
                  log.error(`syncBaseline: Error checking ${missingDir} after retry:`, error.message);
                  stillMissing.push(missingDir);
                }
              }

              if (stillMissing.length > 0) {
                log.error(`syncBaseline: Still missing ${stillMissing.length} directories after retry:`, stillMissing);
                throw new Error(`Missing directories after retry: ${stillMissing.join(', ')}`);
              }

              log.debug(`syncBaseline: ✓ All directories now exist after retry`);
            }

            log.debug(`syncBaseline: ✓ All directories verified - proceeding with bulk upload`);

            progress.report({ increment: 10, message: "Starting bulk upload..." });

            // Use individual cp commands instead of bulk upload
            log.debug(`syncBaseline: Using individual cp commands for upload`);

            // Verify all local files exist before building command
            const validFiles = [];
            const missingFiles = [];
            for (const relativePath of files) {
              const localPath = path.join(syncRoot, relativePath);

              try {
                await fs.access(localPath);
                validFiles.push(relativePath);
                log.debug(`syncBaseline: ✓ Local file exists: ${localPath}`);
              } catch (error) {
                log.error(`syncBaseline: ✗ Local file missing: ${localPath}`);
                missingFiles.push(relativePath);
              }
            }

            log.debug(`syncBaseline: ${validFiles.length}/${files.length} local files are accessible`);

            // Warn user about missing files
            if (missingFiles.length > 0) {
              log.warn(`syncBaseline: Skipping ${missingFiles.length} missing files:`, missingFiles.slice(0, 5));
              if (missingFiles.length > 5) {
                log.warn(`syncBaseline: ... and ${missingFiles.length - 5} more`);
              }
              vscode.window.showWarningMessage(
                `Found ${missingFiles.length} files in manifest that don't exist locally. These will be skipped. Consider rebuilding the manifest.`
              );
            }

            // Update total for progress reporting
            const actualTotal = validFiles.length;

            log.debug(`syncBaseline: Starting individual uploads for ${actualTotal} files...`);

            let uploaded = 0;
            let failed = 0;

            for (const relativePath of validFiles) {
              const localPath = path.join(syncRoot, relativePath);
              const devicePath = path.posix.join(rootPath, relativePath);

              // Double-check file exists before attempting upload (in case it was deleted during the process)
              try {
                await fs.access(localPath);
              } catch (accessError) {
                log.error(`syncBaseline: ✗ File no longer exists during individual upload: ${localPath}`);
                failed++;
                continue;
              }

              try {
                log.debug(`syncBaseline: Individual upload ${uploaded + 1}/${actualTotal}: ${localPath} -> ${devicePath}`);

                progress.report({
                  increment: (80 / actualTotal),
                  message: `Uploading ${relativePath} (${uploaded + 1}/${actualTotal})`
                });

                // Use cpToDevice which includes directory creation logic
                log.debug(`syncBaseline: Executing cpToDevice: ${localPath} -> ${devicePath}`);

                await withAutoSuspend(() => mp.cpToDevice(localPath, devicePath));

                tree.addNode(devicePath, false); // Add file to tree

                uploaded++;
                log.debug(`syncBaseline: ✓ Individual upload ${uploaded}/${actualTotal} successful: ${relativePath}`);

              } catch (individualError: any) {
                failed++;
                log.error(`syncBaseline: ✗ Individual upload failed for ${relativePath}:`, individualError.message);

                // Continue with next file instead of failing completely
                // This allows partial success even if some files fail
              }
            }

            log.debug(`syncBaseline: Individual uploads completed. ${uploaded} successful, ${failed} failed.`);

            if (failed > 0) {
              log.warn(`syncBaseline: ${failed} files failed to upload individually`);
            }

            progress.report({ increment: 100, message: "All files uploaded successfully" });
          });
        });

        // Save manifest locally only (no device manifest to avoid .mpy-workbench folder on board)
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, man);
        log.debug(`syncBaseline: ✓ Manifest saved locally: ${manifestPath}`);

        vscode.window.showInformationMessage("Board: Sync all files (Local → Board) completed");
        // Clear any diff/local-only markers after successful sync-all
        decorations.clear();
        tree.refreshTree();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Upload failed: ${error?.message ?? String(error)}`);
      }
    }),

    vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoard", async () => {
      // Close the REPL terminal if open to avoid port conflicts
      if (isReplOpen()) {
        await disconnectReplTerminal();
        await new Promise(r => setTimeout(r, 400));
      }
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
      const matcher = await createIgnoreMatcher(ws.uri.fsPath);
      const syncRoot = getSyncRoot(ws);
      const candidates = deviceStats
        .filter(stat => !stat.isDir)
        .filter(stat => {
          const rel = toLocalRelative(stat.path, rootPath);
          return !matcher(rel, false);
        });
      // Never write through a local symlink: that would overwrite the linked
      // library's original file outside the project (#34).
      const toDownload: typeof candidates = [];
      const skippedLinks: string[] = [];
      for (const stat of candidates) {
        const rel = toLocalRelative(stat.path, rootPath);
        if (await pathHasSymlink(syncRoot, rel)) skippedLinks.push(rel);
        else toDownload.push(stat);
      }
      if (skippedLinks.length > 0) {
        log.info(`Download all: skipped ${skippedLinks.length} file(s) that are symlinks locally:`, skippedLinks);
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync all files (Board → Local)", cancellable: false }, async (progress) => {
        let done = 0;
        const total = toDownload.length;
        await withAutoSuspend(async () => {
          for (const stat of toDownload) {
            const rel = toLocalRelative(stat.path, rootPath);
            const abs = path.join(syncRoot, ...rel.split("/"));
            progress.report({ message: `Downloading ${rel} (${++done}/${total})` });
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await mp.cpFromDevice(stat.path, abs);
            tree.addNode(stat.path, false); // Add downloaded file to tree
          }
        });
      });
      vscode.window.showInformationMessage("Board: Sync all files (Board → Local) completed");
      // Clear any diff/local-only markers after successful sync-all
      decorations.clear();
      tree.refreshTree();
    }),



    vscode.commands.registerCommand("mpyWorkbench.openSerial", openReplTerminal),
    vscode.commands.registerCommand("mpyWorkbench.openRepl", async () => {
      const term = await getReplTerminal(context);
      term.show(true);
    }),
    vscode.commands.registerCommand("mpyWorkbench.stopSerial", async () => {
      await closeReplTerminal();
      vscode.window.showInformationMessage("Board: ESP32 REPL closed");
    }),

    vscode.commands.registerCommand("mpyWorkbench.autoSuspendLs", async (pathArg: string) => {
      listingInProgress = true;
      try {
        const usePyRaw = vscode.workspace.getConfiguration().get<boolean>("mpyWorkbench.usePyRawList", false);
        return await withAutoSuspend(() => (usePyRaw ? listDirPyRaw(pathArg) : mp.lsTyped(pathArg)), { preempt: false });
      } finally {
        listingInProgress = false;
      }
    }),
    // Keep welcome button visibility in sync if user changes settings directly
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mpyWorkbench.connect')) updatePortContext();
      if (e.affectsConfiguration('mpyWorkbench.pythonPath')) clearPythonCache();
    }),

    vscode.commands.registerCommand("mpyWorkbench.uploadActiveFile", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("No active editor"); return; }
      await ed.document.save();
      const ws = vscode.workspace.getWorkspaceFolder(ed.document.uri);
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      let rel: string;
      if (ws) {
        const r = syncRelative(getSyncRoot(ws), ed.document.uri.fsPath);
        if (!r) {
          vscode.window.showWarningMessage("This file is outside mpyWorkbench.localRoot, so it has no place on the board.");
          return;
        }
        rel = r;
        try {
          const matcher = await createIgnoreMatcher(ws.uri.fsPath);
          if (matcher(rel, false)) {
            vscode.window.showInformationMessage(`Upload skipped (ignored): ${rel}`);
            return;
          }
        } catch {}
      } else {
        rel = path.basename(ed.document.uri.fsPath);
      }
      const dest = toDevicePath(rel, rootPath);
      // Use replacing upload to avoid partial writes while code may autostart
      try {
        await withAutoSuspend(() => mp.uploadReplacing(ed.document.uri.fsPath, dest));
        tree.addNode(dest, false);
        vscode.window.showInformationMessage(`Uploaded to ${dest}`);
        tree.refreshTree();
      } catch (uploadError: any) {
        log.error(`Failed to upload active file to board:`, uploadError);
        vscode.window.showErrorMessage(`Failed to upload active file to board: ${uploadError?.message || uploadError}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.runActiveFile", runActiveFile),
    vscode.commands.registerCommand("mpyWorkbench.openFile", async (node: Esp32Node) => {
      if (node.kind !== "file") return;
      const ws = vscode.workspace.workspaceFolders?.[0];
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      if (ws) {
        const rel = toLocalRelative(node.path, rootPath);
        const abs = path.join(getSyncRoot(ws), ...rel.split("/"));
        await fs.mkdir(path.dirname(abs), { recursive: true });

        // Check if file is local-only (exists locally but not on board)
        const isLocalOnly = (node as any).isLocalOnly;

        if (isLocalOnly) {
          // For local-only files, just open the local file directly
          log.debug(`openFile (extension): Opening local-only file: ${abs}`);
        } else {
          // For files that should exist on board, check if present locally first
          const fileExistsLocally = await fs.access(abs).then(() => true).catch(() => false);
          if (!fileExistsLocally) {
            log.debug(`openFile (extension): File not found locally, copying from board: ${node.path} -> ${abs}`);
            try {
              await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
              log.debug(`openFile (extension): Successfully copied file from board`);
            } catch (copyError: any) {
              log.error(`openFile (extension): Failed to copy file from board:`, copyError);
              vscode.window.showErrorMessage(`Failed to copy file from board: ${copyError?.message || copyError}`);
              return; // Don't try to open the file if copy failed
            }
          } else {
            log.debug(`openFile (extension): File already exists locally: ${abs}`);
          }
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: false });
        await context.workspaceState.update("mpyWorkbench.lastOpenedPath", abs);
      } else {
        // Fallback: no workspace, use temp
        const temp = vscode.Uri.joinPath(context.globalStorageUri, node.path.replace(/\//g, "_"));
        await fs.mkdir(path.dirname(temp.fsPath), { recursive: true });
        try {
          await withAutoSuspend(() => mp.cpFromDevice(node.path, temp.fsPath));
          const doc = await vscode.workspace.openTextDocument(temp);
          await vscode.window.showTextDocument(doc, { preview: true });
          await context.workspaceState.update("mpyWorkbench.lastOpenedPath", temp.fsPath);
        } catch (copyError: any) {
          log.error(`openFile (extension fallback): Failed to copy file to temp location:`, copyError);
          vscode.window.showErrorMessage(`Failed to copy file from board to temp location: ${copyError?.message || copyError}`);
        }
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.downloadFileFromBoard", async (node: Esp32Node) => {
      if (node.kind !== "file") return;
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }
      if (isReplOpen()) {
        await disconnectReplTerminal();
        await new Promise(r => setTimeout(r, 400));
      }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(getSyncRoot(ws), ...rel.split("/"));
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
        tree.addNode(node.path, false);
        vscode.window.showInformationMessage(`Downloaded to ${rel}`);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Download failed: ${err?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.mkdir", async (node?: Esp32Node) => {
      const base = node?.kind === "dir" ? node.path : (node ? path.posix.dirname(node.path) : "/");
      const name = await vscode.window.showInputBox({ prompt: "New folder name", validateInput: v => v ? undefined : "Required" });
      if (!name) return;
      const target = base === "/" ? `/${name}` : `${base}/${name}`;
      await withAutoSuspend(() => mp.mkdir(target));
      tree.addNode(target, true);
    }),
    vscode.commands.registerCommand("mpyWorkbench.deleteAllBoard", async () => {
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const warn = await vscode.window.showWarningMessage(
        `This will DELETE ALL files and folders under '${rootPath}' on the board. This cannot be undone.`,
        { modal: true },
        "Delete All"
      );
      if (warn !== "Delete All") return;
      
      // Show detailed progress
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Deleting all files from ${rootPath}...`,
        cancellable: false
      }, async (progress, token) => {
        progress.report({ increment: 0, message: "Scanning board files..." });
        
        try {
          // Get list of files to show progress
          const items = await withAutoSuspend(() => mp.listTreeStats(rootPath));
          const totalItems = items.length;
          
          if (totalItems === 0) {
            progress.report({ increment: 100, message: "No files to delete!" });
            vscode.window.showInformationMessage(`Board: No files found under ${rootPath}`);
            return;
          }
          
          progress.report({ increment: 20, message: `Found ${totalItems} items to delete...` });
          
          // Delete everything under rootPath
          const result = await withAutoSuspend(() => mp.deleteAllInPath(rootPath));
          
          progress.report({ increment: 80, message: "Verifying deletion..." });
          
          // Verificar lo que queda
          const remaining = await withAutoSuspend(() => mp.listTreeStats(rootPath));
          
          progress.report({ increment: 100, message: "Deletion complete!" });
          
          // Reportar resultados
          const deletedCount = (result as any).deleted_count ?? result.deleted.length;
          const errorCount = (result as any).error_count ?? result.errors.length;
          const remainingCount = remaining.length;
          
          if (errorCount > 0) {
            log.warn("Delete errors:", result.errors);
            vscode.window.showWarningMessage(
              `Board: Deleted ${deletedCount} items, but ${errorCount} failed. ${remainingCount} items remain. Check console for details.`
            );
          } else if (remainingCount > 0) {
            vscode.window.showWarningMessage(
              `Board: Deleted ${deletedCount} items, but ${remainingCount} system files remain (this is normal).`
            );
          } else {
            vscode.window.showInformationMessage(
              `Board: Successfully deleted all ${deletedCount} files and folders under ${rootPath}`
            );
          }
          
        } catch (error: any) {
          progress.report({ increment: 100, message: "Deletion failed!" });
          vscode.window.showErrorMessage(`Failed to delete files from board: ${error?.message ?? String(error)}`);
        }
      });
      // Update tree without relisting: leave root directory empty in cache
      tree.resetDir(rootPath);
    }),
    vscode.commands.registerCommand("mpyWorkbench.deleteAllBoardFromView", async () => {
      await vscode.commands.executeCommand("mpyWorkbench.deleteAllBoard");
    }),
    // View wrappers: run commands without pre-ops (no kill/Ctrl-C)
    vscode.commands.registerCommand("mpyWorkbench.runFromView", async (cmd: string, ...args: any[]) => {
      setSkipIdleOnce();
      try { await vscode.commands.executeCommand(cmd, ...args); } catch (e) {
        const msg = (e as any)?.message ?? String(e);
  vscode.window.showErrorMessage(`Board command failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaseline"); }),
    vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoardFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaselineFromBoard"); }),
    vscode.commands.registerCommand("mpyWorkbench.runActiveFileFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.runActiveFile"); }),
    vscode.commands.registerCommand("mpyWorkbench.openReplFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.openRepl"); }),

    // Context-menu commands of the board Files view. They are declared in package.json
    // and were unregistered by mistake in fbb4a16, which made the menu entries fail
    // with "command not found".
    vscode.commands.registerCommand("mpyWorkbench.newFileBoardAndLocal", async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const filename = await vscode.window.showInputBox({
        prompt: "New file name (relative to project root)",
        placeHolder: "main.py, lib/utils.py, ...",
        validateInput: validateRelativeName
      });
      if (!filename) return;
      const rel = normalizeRelativeName(filename);
      const abs = path.join(getSyncRoot(ws), ...rel.split("/"));
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, "", { flag: "wx" });
      } catch (e: any) {
        if (e.code !== "EEXIST") {
          vscode.window.showErrorMessage("Could not create file: " + e.message);
          return;
        }
      }
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc, { preview: false });
      // Upload to the board on first save (unless ignored)
      const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
        if (savedDoc.uri.fsPath !== abs) return;
        saveDisposable.dispose();
        const devicePath = toDevicePath(rel, rootPath);
        try {
          const matcher = await createIgnoreMatcher(ws.uri.fsPath);
          if (matcher(rel, false)) {
            vscode.window.showInformationMessage(`File saved (ignored for upload): ${rel}`);
            return;
          }
          await withAutoSuspend(() => mp.cpToDevice(abs, devicePath));
          tree.addNode(devicePath, false);
          vscode.window.showInformationMessage(`File saved locally and uploaded to board: ${rel}`);
        } catch (err: any) {
          vscode.window.showWarningMessage(`File saved locally but upload to board failed: ${err?.message ?? String(err)}`);
        }
      });
      context.subscriptions.push(saveDisposable);
    }),
    vscode.commands.registerCommand("mpyWorkbench.openFileFromLocal", async (node: Esp32Node) => {
      if (node?.kind !== "file") return;
      const abs = deviceToLocalAbs(node.path);
      if (!abs) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      try {
        await fs.access(abs);
        const doc = await vscode.workspace.openTextDocument(abs);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch {
        vscode.window.showErrorMessage(`File not found in local workspace: ${abs}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.syncFileLocalToBoard", async (node: Esp32Node) => {
      if (node?.kind !== "file") return;
      const abs = deviceToLocalAbs(node.path);
      if (!abs) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      try {
        try {
          await fs.access(abs);
        } catch {
          const pick = await vscode.window.showWarningMessage(`Local file not found: ${abs}. Download from board first?`, { modal: true }, "Download");
          if (pick !== "Download") return;
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
        }
        await withAutoSuspend(() => mp.cpToDevice(abs, node.path));
        tree.addNode(node.path, false);
        vscode.window.showInformationMessage(`Synced local → board: ${node.path}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Sync failed: ${err?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.syncFileBoardToLocal", async (node: Esp32Node) => {
      if (node?.kind !== "file") return;
      const abs = deviceToLocalAbs(node.path);
      if (!abs) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
        tree.addNode(node.path, false);
        vscode.window.showInformationMessage(`Synced board → local: ${node.path}`);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Sync failed: ${err?.message ?? String(err)}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.delete", async (node: Esp32Node) => {
      if (!node) return;
      const ok = await vscode.window.showWarningMessage(`Delete ${node.path} from board?`, { modal: true }, "Delete");
      if (ok !== "Delete") return;
      await deleteFromBoardWithProgress(node);
    }),
    vscode.commands.registerCommand("mpyWorkbench.deleteBoardAndLocal", async (node: Esp32Node) => {
      if (!node) return;
      const ok = await vscode.window.showWarningMessage(`Delete ${node.path} from board AND local workspace?`, { modal: true }, "Delete");
      if (ok !== "Delete") return;
      const deleted = await deleteFromBoardWithProgress(node);
      if (!deleted) return; // keep the local copy if the board delete failed
      const abs = deviceToLocalAbs(node.path);
      if (abs) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(abs), { recursive: true, useTrash: true });
        } catch { /* not present locally */ }
        localFilesTree.refreshTree();
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.newFileInTree", async (node?: Esp32Node) => {
      const baseDevice = node ? (node.kind === "dir" ? node.path : path.posix.dirname(node.path)) : "/";
      const newName = await vscode.window.showInputBox({
        prompt: `New file name (in ${baseDevice})`,
        placeHolder: "filename.ext or subfolder/filename.ext",
        validateInput: validateRelativeName
      });
      if (!newName) return;
      const devicePath = path.posix.join(baseDevice, normalizeRelativeName(newName));
      const localPath = deviceToLocalAbs(devicePath);
      if (!localPath) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      try {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, "", { flag: "wx" });
      } catch (err: any) {
        if (err?.code !== "EEXIST") {
          vscode.window.showErrorMessage(`Error creating file: ${err?.message ?? err}`);
          return;
        }
      }
      try {
        await withAutoSuspend(() => mp.uploadReplacing(localPath, devicePath));
        tree.addNode(devicePath, false);
        vscode.window.showInformationMessage(`File created: ${devicePath}`);
      } catch (err: any) {
        vscode.window.showWarningMessage(`File created locally but upload to board failed: ${err?.message ?? err}`);
      }
      localFilesTree.refreshTree();
    }),
    vscode.commands.registerCommand("mpyWorkbench.newFolderInTree", async (node?: Esp32Node) => {
      const baseDevice = node ? (node.kind === "dir" ? node.path : path.posix.dirname(node.path)) : "/";
      const newName = await vscode.window.showInputBox({
        prompt: `New folder name (in ${baseDevice})`,
        placeHolder: "folder or subfolder/name",
        validateInput: validateRelativeName
      });
      if (!newName) return;
      const devicePath = path.posix.join(baseDevice, normalizeRelativeName(newName));
      try {
        await withAutoSuspend(() => mp.mkdir(devicePath));
        tree.addNode(devicePath, true);
        const localPath = deviceToLocalAbs(devicePath);
        if (localPath) await fs.mkdir(localPath, { recursive: true });
        localFilesTree.refreshTree();
        vscode.window.showInformationMessage(`Folder created: ${devicePath}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error creating folder: ${err?.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.renameNode", async (node: Esp32Node) => {
      if (!node) return;
      const oldPath = node.path;
      const base = path.posix.dirname(oldPath);
      const oldName = path.posix.basename(oldPath);
      const newName = await vscode.window.showInputBox({
        prompt: `New name for ${oldName}`,
        value: oldName,
        validateInput: v => {
          if (!v || v === oldName) return "Name must be different and not empty";
          if (v.includes("/") || v.includes("\\") || v === "." || v === "..") return "Invalid name";
          return undefined;
        }
      });
      if (!newName || newName === oldName) return;
      const newPath = base === "/" ? `/${newName}` : `${base}/${newName}`;
      try {
        await withAutoSuspend(() => mp.mvOnDevice(oldPath, newPath));
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error renaming on board: ${err?.message ?? err}`);
        return;
      }
      // Rename the local copy too, if there is one
      const localOld = deviceToLocalAbs(oldPath);
      const localNew = deviceToLocalAbs(newPath);
      if (localOld && localNew) {
        try { await fs.rename(localOld, localNew); } catch { /* not present locally */ }
        localFilesTree.refreshTree();
      }
      tree.removeNode(oldPath);
      tree.addNode(newPath, node.kind === "dir");
      vscode.window.showInformationMessage(`Renamed: ${oldPath} → ${newPath}`);
    })
  );
  // Auto-upload on save: if file is inside a workspace, push to device path mapped by mpyWorkbench.rootPath
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!ws) return;
      // Only create .mpy-workbench directory if workspace is initialized
      const initialized = await isLocalSyncInitialized();
      if (!initialized) return;
      // ensure project config folder exists
  await ensureMpyWorkbenchDir(ws.uri.fsPath);
      const enabled = await workspaceAutoSyncEnabled(ws.uri.fsPath);
      if (!enabled) {
        const now = Date.now();
        if (now - lastLocalOnlyNotice > 5000) {
          vscode.window.setStatusBarMessage("Board: Auto sync disabled — saved locally only (workspace)", 3000);
          lastLocalOnlyNotice = now;
        }
        return; // save locally only
      }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const rel = syncRelative(getSyncRoot(ws), doc.uri.fsPath);
      if (!rel) return; // outside mpyWorkbench.localRoot: nothing to upload
      try {
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        if (matcher(rel, false)) {
          // Skip auto-upload for ignored files
          return;
        }
      } catch {}
      const deviceDest = toDevicePath(rel, rootPath);
      try {
        await withAutoSuspend(() => mp.cpToDevice(doc.uri.fsPath, deviceDest));
        tree.addNode(deviceDest, false);
      }
      catch (e) {
        log.error(`Auto-upload failed for ${rel}:`, e);
        vscode.window.showWarningMessage(`Board auto-upload failed for ${rel}: ${String((e as any)?.message ?? e)}`);
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal.name === "ESP32 REPL") {
        // replTerminal is now managed in mpremoteCommands.ts
      }
      clearRunFileTerminalIf(terminal);
    })
  );
  // Command to toggle workspace-level autosync setting
  context.subscriptions.push(vscode.commands.registerCommand('mpyWorkbench.toggleWorkspaceAutoSync', async () => {
    try {
      const ws = getWorkspaceFolder();
      const cfg = await readWorkspaceConfig(ws.uri.fsPath);
      const current = !!cfg.autoSyncOnSave;
      cfg.autoSyncOnSave = !current;
      await writeWorkspaceConfig(ws.uri.fsPath, cfg);
      vscode.window.showInformationMessage(`Workspace auto-sync on save is now ${cfg.autoSyncOnSave ? 'ENABLED' : 'DISABLED'}`);
  try { await refreshAutoSyncStatus(); } catch {}
      setTimeout(() => syncTree.refreshTree(), 0);
    } catch (e) {
      vscode.window.showErrorMessage('Failed to toggle workspace auto-sync: ' + String(e));
    }
  }));
}

export function deactivate() {
  log.dispose();
}
