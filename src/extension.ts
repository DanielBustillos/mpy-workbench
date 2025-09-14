
import * as vscode from "vscode";
import { Esp32Tree } from "./esp32Fs";
import { ActionsTree } from "./actions";
import { SyncTree } from "./syncView";
import { Esp32Node } from "./types";
import * as mp from "./mpremote";
import { refreshFileTreeCache, debugTreeParsing, debugFilesystemStatus, runMpremote } from "./mpremote";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec } from "node:child_process";
import { buildManifest, diffManifests, saveManifest, loadManifest, defaultIgnorePatterns, createIgnoreMatcher, Manifest } from "./sync";
import { Esp32DecorationProvider } from "./decorations";
import { listDirPyRaw } from "./pyraw";
import { BoardOperations } from "./boardOperations";
// import { monitor } from "./monitor"; // switched to auto-suspend REPL strategy
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
  toDevicePath
} from "./mpremoteCommands";

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
      console.error('Failed to write .mpy-workbench config', e);
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
  const decorations = new Esp32DecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
  // Export decorations for use in other modules
  (global as any).esp32Decorations = decorations;

  // Create BoardOperations instance
  const boardOperations = new BoardOperations(tree, decorations);
  let lastLocalOnlyNotice = 0;

  // Status bar item to show workspace auto-sync state
  const autoSyncStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  autoSyncStatus.command = 'mpyWorkbench.toggleWorkspaceAutoSync';
  autoSyncStatus.tooltip = 'Toggle workspace Auto-Sync on Save';
  context.subscriptions.push(autoSyncStatus);

  async function refreshAutoSyncStatus() {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        autoSyncStatus.text = 'MPY: no ws';
        autoSyncStatus.show();
        return;
      }
      const enabled = await workspaceAutoSyncEnabled(ws.uri.fsPath);
      autoSyncStatus.text = enabled ? 'MPY: AutoSync ON' : 'MPY: AutoSync OFF';
      autoSyncStatus.color = enabled ? undefined : new vscode.ThemeColor('statusBarItem.warningForeground');
      autoSyncStatus.show();
    } catch (e) {
      autoSyncStatus.text = 'MPY: ?';
      autoSyncStatus.show();
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
  }

  // Initialize status bar on activation
  refreshAutoSyncStatus();

  // Ensure sensible ignore files exist or are upgraded from old stub
  try {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      ensureWorkbenchIgnoreFile(ws.uri.fsPath).catch(() => {});
    }
  } catch {}

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
  context.subscriptions.push(
    view,
    actionsView,
    syncView,
    vscode.commands.registerCommand("mpyWorkbench.refresh", () => {
      // Clear cache and force next listing to come from device
      tree.clearCache();
      tree.enableRawListForNext();
      tree.refreshTree();
    }),
    vscode.commands.registerCommand("mpyWorkbench.refreshFileTreeCache", async () => {
      try {
        console.log("[DEBUG] Starting manual file tree cache refresh...");
        await mp.refreshFileTreeCache();
        console.log("[DEBUG] File tree cache refresh completed");
        vscode.window.showInformationMessage("File tree cache refreshed successfully");
      } catch (error: any) {
        console.error("[DEBUG] File tree cache refresh failed:", error);
        vscode.window.showErrorMessage(`File tree cache refresh failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.rebuildManifest", async () => {
      try {
        console.log("[DEBUG] Starting manual manifest rebuild...");
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
          vscode.window.showErrorMessage("No workspace folder open");
          return;
        }

        // Ensure directories exist
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);

        // Rebuild manifest
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const newManifest = await buildManifest(ws.uri.fsPath, matcher);
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, newManifest);

        console.log("[DEBUG] Manifest rebuild completed");
        vscode.window.showInformationMessage(`Manifest rebuilt successfully (${Object.keys(newManifest.files).length} files)`);
      } catch (error: any) {
        console.error("[DEBUG] Manifest rebuild failed:", error);
        vscode.window.showErrorMessage(`Manifest rebuild failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.debugTreeParsing", async () => {
      try {
        console.log("[DEBUG] Starting tree parsing debug...");
        await debugTreeParsing();
        console.log("[DEBUG] Tree parsing debug completed");
        vscode.window.showInformationMessage("Tree parsing debug completed - check console for details");
      } catch (error: any) {
        console.error("[DEBUG] Tree parsing debug failed:", error);
        vscode.window.showErrorMessage(`Tree parsing debug failed: ${error?.message || error}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.debugFilesystemStatus", async () => {
      try {
        console.log("[DEBUG] Starting filesystem status debug...");
        await debugFilesystemStatus();
        console.log("[DEBUG] Filesystem status debug completed");
        vscode.window.showInformationMessage("Filesystem status debug completed - check console for details");
      } catch (error: any) {
        console.error("[DEBUG] Filesystem status debug failed:", error);
        vscode.window.showErrorMessage(`Filesystem status debug failed: ${error?.message || error}`);
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

    vscode.commands.registerCommand("mpyWorkbench.newFileBoardAndLocal", async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const filename = await vscode.window.showInputBox({
        prompt: "New file name (relative to project root)",
        placeHolder: "main.py, lib/utils.py, ..."
      });
      if (!filename || filename.endsWith("/")) return;
      const abs = path.join(ws.uri.fsPath, ...filename.split("/"));
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
      // On first save, upload to board (unless ignored)
      const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
        if (savedDoc.uri.fsPath !== abs) return;
        const devicePath = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/" + filename.replace(/^\/+/, "");
        try {
          const matcher = await createIgnoreMatcher(ws.uri.fsPath);
          const rel = filename.replace(/^\/+/, "");
          if (matcher(rel.replace(/\\/g, '/'), false)) {
            vscode.window.showInformationMessage(`File saved (ignored for upload): ${filename}`);
          } else {
            try {
              await withAutoSuspend(() => mp.cpToDevice(abs, devicePath));
              vscode.window.showInformationMessage(`File saved locally and uploaded to board: ${filename}`);
              tree.addNode(devicePath, false);
            } catch (uploadError: any) {
              console.error(`[DEBUG] Failed to upload new file to board:`, uploadError);
              vscode.window.showWarningMessage(`File saved locally but upload to board failed: ${uploadError?.message || uploadError}`);
            }
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Error uploading file to board: ${err?.message ?? err}`);
        }
        saveDisposable.dispose();
      });
    }),

    vscode.commands.registerCommand("mpyWorkbench.openFileFromLocal", async (node: Esp32Node) => {
      if (node.kind !== "file") return;
      try {
        const ws = getWorkspaceFolder();
        const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
        const rel = toLocalRelative(node.path, rootPath);
        const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
        await fs.access(abs);
        const doc = await vscode.workspace.openTextDocument(abs);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (error) {
        vscode.window.showErrorMessage(`File not found in local workspace: ${toLocalRelative(node.path, vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/"))}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.syncFileLocalToBoard", async (node: Esp32Node) => {
      if (node.kind !== "file") return;
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
      try {
        await fs.access(abs);
      } catch {
        const pick = await vscode.window.showWarningMessage(`Local file not found: ${rel}. Download from board first?`, { modal: true }, "Download");
        if (pick !== "Download") return;
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
      }
      await withAutoSuspend(() => mp.cpToDevice(abs, node.path));
      tree.addNode(node.path, false); // Add uploaded file to tree
      vscode.window.showInformationMessage(`Synced local → board: ${rel}`);
    }),
    vscode.commands.registerCommand("mpyWorkbench.syncFileBoardToLocal", async (node: Esp32Node) => {
      if (node.kind !== "file") return;
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const rel = toLocalRelative(node.path, rootPath);
      const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
      tree.addNode(node.path, false); // Ensure presence in tree (no relisting)
      vscode.window.showInformationMessage(`Synced board → local: ${rel}`);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {}
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
          const initialize = await vscode.window.showWarningMessage(
            "The local folder is not initialized for synchronization. Would you like to initialize it now?",
            { modal: true },
            "Initialize"
          );
          if (initialize !== "Initialize") return;
          // Create initial manifest to initialize sync
          await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
          const matcher = await createIgnoreMatcher(ws.uri.fsPath);
          const initialManifest = await buildManifest(ws.uri.fsPath, matcher);
          const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
          await saveManifest(manifestPath, initialManifest);
          vscode.window.showInformationMessage("Local folder initialized for synchronization.");
        }

        const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
        const matcher2 = await createIgnoreMatcher(ws.uri.fsPath);
        const man = await buildManifest(ws.uri.fsPath, matcher2);

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

            console.log(`[DEBUG] syncBaseline: Need to create ${sortedDirectories.length} directories:`, sortedDirectories);

            // Create directories in hierarchical order with retry logic
            let createdCount = 0;
            let failedDirectories: string[] = [];

            console.log(`[DEBUG] syncBaseline: Starting directory creation for ${sortedDirectories.length} directories...`);

            for (const deviceDir of sortedDirectories) {
              let created = false;
              let attempts = 0;
              const maxAttempts = 3;

              while (!created && attempts < maxAttempts) {
                attempts++;
                try {
                  console.log(`[DEBUG] syncBaseline: Creating directory ${deviceDir} (attempt ${attempts}/${maxAttempts})`);
                  await mp.mkdir(deviceDir);
                  tree.addNode(deviceDir, true); // Add folder to tree
                  created = true;
                  createdCount++;
                  console.log(`[DEBUG] syncBaseline: ✓ Created directory ${deviceDir} (${createdCount}/${sortedDirectories.length})`);
                } catch (error: any) {
                  console.log(`[DEBUG] syncBaseline: ✗ Directory ${deviceDir} creation failed (attempt ${attempts}):`, error.message);

                  if (attempts >= maxAttempts) {
                    failedDirectories.push(deviceDir);
                    console.error(`[DEBUG] syncBaseline: ✗✗ Giving up on directory ${deviceDir} after ${maxAttempts} attempts`);
                  } else {
                    // Wait a bit before retrying
                    await new Promise(resolve => setTimeout(resolve, 100));
                  }
                }
              }
            }

            console.log(`[DEBUG] syncBaseline: Directory creation completed. Created ${createdCount} out of ${sortedDirectories.length} directories.`);

            if (failedDirectories.length > 0) {
              console.error(`[DEBUG] syncBaseline: Failed to create ${failedDirectories.length} directories:`, failedDirectories);
            }

            // Verify that ALL directories exist before proceeding with bulk upload
            console.log(`[DEBUG] syncBaseline: Verifying ALL directories exist before bulk upload...`);
            let allDirectoriesExist = true;
            const verificationFailures: string[] = [];

            for (const deviceDir of sortedDirectories) {
              try {
                const exists = await mp.fileExists(deviceDir);
                if (!exists) {
                  console.error(`[DEBUG] syncBaseline: ✗ Directory ${deviceDir} does not exist!`);
                  verificationFailures.push(deviceDir);
                  allDirectoriesExist = false;
                } else {
                  console.log(`[DEBUG] syncBaseline: ✓ Directory ${deviceDir} verified`);
                }
              } catch (error: any) {
                console.error(`[DEBUG] syncBaseline: ✗ Error checking directory ${deviceDir}:`, error.message);
                verificationFailures.push(deviceDir);
                allDirectoriesExist = false;
              }
            }

            if (!allDirectoriesExist) {
              console.error(`[DEBUG] syncBaseline: Cannot proceed with bulk upload - ${verificationFailures.length} directories missing:`, verificationFailures);

              // Try to create the missing directories one more time
              console.log(`[DEBUG] syncBaseline: Attempting to create missing directories...`);
              for (const missingDir of verificationFailures) {
                try {
                  console.log(`[DEBUG] syncBaseline: Creating missing directory: ${missingDir}`);
                  await mp.mkdir(missingDir);
                  tree.addNode(missingDir, true);
                  console.log(`[DEBUG] syncBaseline: ✓ Successfully created missing directory: ${missingDir}`);
                } catch (createError: any) {
                  console.error(`[DEBUG] syncBaseline: ✗ Failed to create missing directory ${missingDir}:`, createError.message);
                }
              }

              // Verify again after the retry
              console.log(`[DEBUG] syncBaseline: Re-verifying directories after retry...`);
              let stillMissing = [];
              for (const missingDir of verificationFailures) {
                try {
                  const exists = await mp.fileExists(missingDir);
                  if (!exists) {
                    stillMissing.push(missingDir);
                  }
                } catch (error: any) {
                  console.error(`[DEBUG] syncBaseline: Error checking ${missingDir} after retry:`, error.message);
                  stillMissing.push(missingDir);
                }
              }

              if (stillMissing.length > 0) {
                console.error(`[DEBUG] syncBaseline: Still missing ${stillMissing.length} directories after retry:`, stillMissing);
                throw new Error(`Missing directories after retry: ${stillMissing.join(', ')}`);
              }

              console.log(`[DEBUG] syncBaseline: ✓ All directories now exist after retry`);
            }

            console.log(`[DEBUG] syncBaseline: ✓ All directories verified - proceeding with bulk upload`);

            progress.report({ increment: 10, message: "Starting bulk upload..." });

            // Use individual cp commands instead of bulk upload
            console.log(`[DEBUG] syncBaseline: Using individual cp commands for upload`);

            // Verify all local files exist before building command
            const validFiles = [];
            const missingFiles = [];
            for (const relativePath of files) {
              const localPath = path.join(ws.uri.fsPath, relativePath);

              try {
                await fs.access(localPath);
                validFiles.push(relativePath);
                console.log(`[DEBUG] syncBaseline: ✓ Local file exists: ${localPath}`);
              } catch (error) {
                console.error(`[DEBUG] syncBaseline: ✗ Local file missing: ${localPath}`);
                missingFiles.push(relativePath);
              }
            }

            console.log(`[DEBUG] syncBaseline: ${validFiles.length}/${files.length} local files are accessible`);

            // Warn user about missing files
            if (missingFiles.length > 0) {
              console.warn(`[DEBUG] syncBaseline: Skipping ${missingFiles.length} missing files:`, missingFiles.slice(0, 5));
              if (missingFiles.length > 5) {
                console.warn(`[DEBUG] syncBaseline: ... and ${missingFiles.length - 5} more`);
              }
              vscode.window.showWarningMessage(
                `Found ${missingFiles.length} files in manifest that don't exist locally. These will be skipped. Consider rebuilding the manifest.`
              );
            }

            // Update total for progress reporting
            const actualTotal = validFiles.length;

            console.log(`[DEBUG] syncBaseline: Starting individual uploads for ${actualTotal} files...`);

            let uploaded = 0;
            let failed = 0;

            for (const relativePath of validFiles) {
              const localPath = path.join(ws.uri.fsPath, relativePath);
              const devicePath = path.posix.join(rootPath, relativePath);

              // Double-check file exists before attempting upload (in case it was deleted during the process)
              try {
                await fs.access(localPath);
              } catch (accessError) {
                console.error(`[DEBUG] syncBaseline: ✗ File no longer exists during individual upload: ${localPath}`);
                failed++;
                continue;
              }

              try {
                console.log(`[DEBUG] syncBaseline: Individual upload ${uploaded + 1}/${actualTotal}: ${localPath} -> ${devicePath}`);

                progress.report({
                  increment: (80 / actualTotal),
                  message: `Uploading ${relativePath} (${uploaded + 1}/${actualTotal})`
                });

                // Use individual cp command instead of bulk
                const devicePathWithPrefix = devicePath === "/" ? ":" : `:${devicePath}`;
                const cpArgs = ["connect", "auto", "fs", "cp", localPath, devicePathWithPrefix];
                console.log(`[DEBUG] syncBaseline: Executing: mpremote ${cpArgs.join(' ')}`);

                await runMpremote(cpArgs, { retryOnFailure: true });

                tree.addNode(devicePath, false); // Add file to tree

                uploaded++;
                console.log(`[DEBUG] syncBaseline: ✓ Individual upload ${uploaded}/${actualTotal} successful: ${relativePath}`);

              } catch (individualError: any) {
                failed++;
                console.error(`[DEBUG] syncBaseline: ✗ Individual upload failed for ${relativePath}:`, individualError.message);

                // Continue with next file instead of failing completely
                // This allows partial success even if some files fail
              }
            }

            console.log(`[DEBUG] syncBaseline: Individual uploads completed. ${uploaded} successful, ${failed} failed.`);

            if (failed > 0) {
              console.warn(`[DEBUG] syncBaseline: ${failed} files failed to upload individually`);
            }

            progress.report({ increment: 100, message: "All files uploaded successfully" });
          });
        });

        // Save manifest locally only (no device manifest to avoid .mpy-workbench folder on board)
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, man);
        console.log(`[DEBUG] syncBaseline: ✓ Manifest saved locally: ${manifestPath}`);

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
      const toDownload = deviceStats
        .filter(stat => !stat.isDir)
        .filter(stat => {
          const rel = toLocalRelative(stat.path, rootPath);
          return !matcher(rel, false);
        });
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync all files (Board → Local)", cancellable: false }, async (progress) => {
        let done = 0;
        const total = toDownload.length;
        await withAutoSuspend(async () => {
          for (const stat of toDownload) {
            const rel = toLocalRelative(stat.path, rootPath);
            const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
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
    }),

    vscode.commands.registerCommand("mpyWorkbench.uploadActiveFile", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("No active editor"); return; }
      await ed.document.save();
      const ws = vscode.workspace.getWorkspaceFolder(ed.document.uri);
      const rel = ws ? path.relative(ws.uri.fsPath, ed.document.uri.fsPath) : path.basename(ed.document.uri.fsPath);
      if (ws) {
        try {
          const matcher = await createIgnoreMatcher(ws.uri.fsPath);
          const relPosix = rel.replace(/\\\\/g, '/');
          if (matcher(relPosix, false)) {
            vscode.window.showInformationMessage(`Upload skipped (ignored): ${relPosix}`);
            return;
          }
        } catch {}
      }
      const dest = "/" + rel.replace(/\\\\/g, "/");
      // Use replacing upload to avoid partial writes while code may autostart
      try {
        await withAutoSuspend(() => mp.uploadReplacing(ed.document.uri.fsPath, dest));
        tree.addNode(dest, false);
        vscode.window.showInformationMessage(`Uploaded to ${dest}`);
        tree.refreshTree();
      } catch (uploadError: any) {
        console.error(`[DEBUG] Failed to upload active file to board:`, uploadError);
        vscode.window.showErrorMessage(`Failed to upload active file to board: ${uploadError?.message || uploadError}`);
      }
    }),
    vscode.commands.registerCommand("mpyWorkbench.runActiveFile", runActiveFile),
    vscode.commands.registerCommand("mpyWorkbench.checkDiffs", () => boardOperations.checkDiffs()),
    vscode.commands.registerCommand("mpyWorkbench.syncDiffsLocalToBoard", async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      const initialized = await isLocalSyncInitialized();
      if (!initialized) {
        const initialize = await vscode.window.showWarningMessage(
          "The local folder is not initialized for synchronization. Would you like to initialize it now?",
          { modal: true },
          "Initialize"
        );
        if (initialize !== "Initialize") return;
        
        // Create initial manifest to initialize sync
        await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const initialManifest = await buildManifest(ws.uri.fsPath, matcher);
  const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, initialManifest);
        vscode.window.showInformationMessage("Local folder initialized for synchronization.");
      }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      // Get current diffs and filter to files by comparing with current device stats
      // Check if differences have been detected first
      const allDiffs = decorations.getDiffsFilesOnly();
      const allLocalOnly = decorations.getLocalOnlyFilesOnly();
      if (allDiffs.length === 0 && allLocalOnly.length === 0) {
        const runCheck = await vscode.window.showInformationMessage(
          "No file differences detected. You need to check for differences first before syncing.",
          "Check Differences Now"
        );
        if (runCheck === "Check Differences Now") {
          await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
          // After checking diffs, try again - check both diffs and local-only files
          const newDiffs = decorations.getDiffsFilesOnly();
          const newLocalOnly = decorations.getLocalOnlyFilesOnly();
          if (newDiffs.length === 0 && newLocalOnly.length === 0) {
            vscode.window.showInformationMessage("No differences found between local and board files.");
            return;
          }
        } else {
          return;
        }
      }

      const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
      const filesSet = new Set(deviceStats.filter(e => !e.isDir).map(e => e.path));
      const diffs = decorations.getDiffsFilesOnly().filter(p => filesSet.has(p));
      const localOnlyFiles = decorations.getLocalOnlyFilesOnly();
      
      // Debug: Log what sync found
      console.log("Debug - syncDiffsLocalToBoard:");
      console.log("- decorations.getDiffsFilesOnly():", decorations.getDiffsFilesOnly());
      console.log("- decorations.getLocalOnlyFilesOnly():", decorations.getLocalOnlyFilesOnly());
      console.log("- diffs (filtered):", diffs);
      console.log("- localOnlyFiles:", localOnlyFiles);
      
      const allFilesToSync = [...diffs, ...localOnlyFiles];
      if (allFilesToSync.length === 0) { 
        vscode.window.showInformationMessage("Board: No diffed files to sync"); 
        return; 
      }
      
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync Files Local → Board", cancellable: false }, async (progress) => {
        let done = 0;
        const total = allFilesToSync.length;
        await withAutoSuspend(async () => {
          for (const devicePath of allFilesToSync) {
            const rel = toLocalRelative(devicePath, rootPath);
            const abs = path.join(ws.uri.fsPath, ...rel.split('/'));
            
            try { 
              await fs.access(abs); 
              // Check if it's a directory and skip it
              const stat = await fs.stat(abs);
              if (stat.isDirectory()) {
                console.log(`Skipping directory: ${abs}`);
                continue;
              }
            } catch { 
              continue; 
            }
            
            const isLocalOnly = localOnlyFiles.includes(devicePath);
            const action = isLocalOnly ? "Uploading (new)" : "Uploading";
            progress.report({ message: `${action} ${rel} (${++done}/${total})` });
            
            await mp.uploadReplacing(abs, devicePath);
            tree.addNode(devicePath, false); // Add uploaded file to tree
          }
        });
      });
      decorations.clear();
      tree.refreshTree();
      const diffCount = diffs.length;
      const localOnlyCount = localOnlyFiles.length;
      const message = localOnlyCount > 0 
        ? `Board: ${diffCount} changed and ${localOnlyCount} new files uploaded to board`
        : `Board: ${diffCount} diffed files uploaded to board`;
      vscode.window.showInformationMessage(message + " and marks cleared");
    }),
    vscode.commands.registerCommand("mpyWorkbench.syncDiffsBoardToLocal", async () => {
      const ws2 = vscode.workspace.workspaceFolders?.[0];
      if (!ws2) { vscode.window.showErrorMessage("No workspace folder open"); return; }
      
      const initialized = await isLocalSyncInitialized();
      if (!initialized) {
        const initialize = await vscode.window.showWarningMessage(
          "The local folder is not initialized for synchronization. Would you like to initialize it now?",
          { modal: true },
          "Initialize"
        );
        if (initialize !== "Initialize") return;
        
        // Create initial manifest to initialize sync
        await ensureWorkbenchIgnoreFile(ws2.uri.fsPath);
        const matcher = await createIgnoreMatcher(ws2.uri.fsPath);
        const initialManifest = await buildManifest(ws2.uri.fsPath, matcher);
  const manifestPath = path.join(ws2.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, initialManifest);
        vscode.window.showInformationMessage("Local folder initialized for synchronization.");
      }
      
      const rootPath2 = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      // Get current diffs and filter to files by comparing with current device stats
      const deviceStats2 = await withAutoSuspend(() => mp.listTreeStats(rootPath2));
      const filesSet2 = new Set(deviceStats2.filter(e => !e.isDir).map(e => e.path));
      const diffs2 = decorations.getDiffsFilesOnly().filter(p => filesSet2.has(p));
      
      if (diffs2.length === 0) {
        const localOnlyFiles = decorations.getLocalOnly();
        if (localOnlyFiles.length > 0) {
          const syncLocalToBoard = await vscode.window.showInformationMessage(
            `Board → Local: No board files to download, but you have ${localOnlyFiles.length} local-only files. Use 'Sync Files (Local → Board)' to upload them to the board.`,
            { modal: true },
            "Sync Local → Board"
          );
          if (syncLocalToBoard === "Sync Local → Board") {
            await vscode.commands.executeCommand("mpyWorkbench.syncDiffsLocalToBoard");
          }
        } else {
          const checkNow = await vscode.window.showWarningMessage(
            "Board: No diffed files found to sync. You need to run 'Check Differences' first to detect changes between board and local files.",
            { modal: true },
            "Check Differences Now"
          );
          if (checkNow === "Check Differences Now") {
            await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
          }
        }
        return;
      }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync Diffed Files Board → Local", cancellable: false }, async (progress) => {
        let done = 0;
        const matcher = await createIgnoreMatcher(ws2.uri.fsPath);
        const filtered = diffs2.filter(devicePath => {
          const rel = toLocalRelative(devicePath, rootPath2);
          return !matcher(rel, false);
        });
        const total = filtered.length;
        await withAutoSuspend(async () => {
          for (const devicePath of filtered) {
            const rel = toLocalRelative(devicePath, rootPath2);
            const abs = path.join(ws2.uri.fsPath, ...rel.split('/'));
            progress.report({ message: `Downloading ${rel} (${++done}/${total})` });
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await mp.cpFromDevice(devicePath, abs);
            tree.addNode(devicePath, false); // Add downloaded file to tree
          }
        });
      });
      decorations.clear();
  vscode.window.showInformationMessage("Board: Diffed files downloaded from board and marks cleared");
  tree.refreshTree();
    }),
    vscode.commands.registerCommand("mpyWorkbench.openFile", async (node: Esp32Node) => {
      if (node.kind !== "file") return;
      const ws = vscode.workspace.workspaceFolders?.[0];
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      if (ws) {
        const rel = toLocalRelative(node.path, rootPath);
        const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
        await fs.mkdir(path.dirname(abs), { recursive: true });

        // Check if file is local-only (exists locally but not on board)
        const isLocalOnly = (node as any).isLocalOnly;

        if (isLocalOnly) {
          // For local-only files, just open the local file directly
          console.log(`[DEBUG] openFile (extension): Opening local-only file: ${abs}`);
        } else {
          // For files that should exist on board, check if present locally first
          const fileExistsLocally = await fs.access(abs).then(() => true).catch(() => false);
          if (!fileExistsLocally) {
            console.log(`[DEBUG] openFile (extension): File not found locally, copying from board: ${node.path} -> ${abs}`);
            try {
              await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
              console.log(`[DEBUG] openFile (extension): Successfully copied file from board`);
            } catch (copyError: any) {
              console.error(`[DEBUG] openFile (extension): Failed to copy file from board:`, copyError);
              vscode.window.showErrorMessage(`Failed to copy file from board: ${copyError?.message || copyError}`);
              return; // Don't try to open the file if copy failed
            }
          } else {
            console.log(`[DEBUG] openFile (extension): File already exists locally: ${abs}`);
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
          console.error(`[DEBUG] openFile (extension fallback): Failed to copy file to temp location:`, copyError);
          vscode.window.showErrorMessage(`Failed to copy file from board to temp location: ${copyError?.message || copyError}`);
        }
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
    vscode.commands.registerCommand("mpyWorkbench.delete", async (node: Esp32Node) => {
      const okBoard = await vscode.window.showWarningMessage(`Delete ${node.path} from board?`, { modal: true }, "Delete");
      if (okBoard !== "Delete") return;
      
      // Mostrar progreso con animación
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Deleting ${node.path}...`,
        cancellable: false
      }, async (progress, token) => {
        progress.report({ increment: 0, message: "Starting deletion..." });
        try {
          // Fast path: one-shot delete (file or directory)
          const isDir = node.kind === "dir";
          progress.report({ increment: 60, message: isDir ? "Removing directory..." : "Removing file..." });
          await withAutoSuspend(() => mp.deleteAny(node.path));
          progress.report({ increment: 100, message: "Deletion complete!" });
          vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
          tree.removeNode(node.path);
        } catch (err: any) {
          progress.report({ increment: 100, message: "Deletion failed!" });
          vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
        }
      });
      
    }),
    vscode.commands.registerCommand("mpyWorkbench.deleteBoardAndLocal", async (node: Esp32Node) => {
      const okBoardLocal = await vscode.window.showWarningMessage(`Delete ${node.path} from board AND local workspace?`, { modal: true }, "Delete");
      if (okBoardLocal !== "Delete") return;
      
      // Mostrar progreso con animación
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Deleting ${node.path} from board and local...`,
        cancellable: false
      }, async (progress, token) => {
        progress.report({ increment: 0, message: "Starting deletion..." });
        
        try {
          // Fast path: one-shot delete on board
          const isDir = node.kind === "dir";
          progress.report({ increment: 50, message: isDir ? "Removing directory from board..." : "Removing file from board..." });
          await withAutoSuspend(() => mp.deleteAny(node.path));
          progress.report({ increment: 70, message: "Board deletion complete!" });
          vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
          tree.removeNode(node.path);
        } catch (err: any) {
          progress.report({ increment: 70, message: "Board deletion failed!" });
          vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
        }
      });
      
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
        const rel = toLocalRelative(node.path, rootPath);
        const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
        try {
          await fs.rm(abs, { recursive: true, force: true });
        } catch {}
      }
      tree.removeNode(node.path);
    }),
    vscode.commands.registerCommand("mpyWorkbench.deleteAllBoard", async () => {
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const warn = await vscode.window.showWarningMessage(
        `This will DELETE ALL files and folders under '${rootPath}' on the board. This cannot be undone.`,
        { modal: true },
        "Delete All"
      );
      if (warn !== "Delete All") return;
      
      // Mostrar progreso con animación detallada
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
          
          // Usar nuestra nueva función para eliminar todo
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
            console.warn("Delete errors:", result.errors);
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

    vscode.commands.registerCommand("mpyWorkbench.checkDiffsFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.checkDiffs"); }),
    vscode.commands.registerCommand("mpyWorkbench.syncDiffsLocalToBoardFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncDiffsLocalToBoard"); }),
    vscode.commands.registerCommand("mpyWorkbench.syncDiffsBoardToLocalFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncDiffsBoardToLocal"); }),
    vscode.commands.registerCommand("mpyWorkbench.runActiveFileFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.runActiveFile"); }),
    vscode.commands.registerCommand("mpyWorkbench.openReplFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.openRepl"); }),
    vscode.commands.registerCommand("mpyWorkbench.newFileInTree", async (node?: Esp32Node) => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;
      // Determine base path on device
      const baseDevice = node
        ? (node.kind === "dir" ? node.path : path.posix.dirname(node.path))
        : "/";
      const baseLabel = baseDevice === "/" ? "/" : baseDevice;
      const newName = await vscode.window.showInputBox({
        prompt: `New file name (in ${baseLabel})`,
        placeHolder: "filename.ext or subfolder/filename.ext",
        validateInput: v => v && !v.endsWith("/") && !v.endsWith("\\") ? undefined : "Name must not end with / and cannot be empty"
      });
      if (!newName) return;
      const devicePath = baseDevice === "/" ? `/${newName.replace(/^\//, "")}` : `${baseDevice}/${newName.replace(/^\//, "")}`;
      try {
        // Create locally first
        const relLocal = devicePath.replace(/^\//, "");
        const localPath = path.join(ws, relLocal);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, "");
        // Upload to board
        try {
          await mp.uploadReplacing(localPath, devicePath);
          vscode.window.showInformationMessage(`File created: ${devicePath}`);
        } catch (uploadError: any) {
          console.error(`[DEBUG] Failed to upload new file to board:`, uploadError);
          vscode.window.showWarningMessage(`File created locally but upload to board failed: ${uploadError?.message || uploadError}`);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error creating file: ${err?.message ?? err}`);
      }
      vscode.commands.executeCommand("mpyWorkbench.refresh");
    }),
    vscode.commands.registerCommand("mpyWorkbench.newFolderInTree", async (node?: Esp32Node) => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;
      const baseDevice = node
        ? (node.kind === "dir" ? node.path : path.posix.dirname(node.path))
        : "/";
      const baseLabel = baseDevice === "/" ? "/" : baseDevice;
      const newName = await vscode.window.showInputBox({
        prompt: `New folder name (in ${baseLabel})`,
        placeHolder: "folder or subfolder/name",
        validateInput: v => v && !v.endsWith(".") && !v.endsWith("/") && !v.endsWith("\\") ? undefined : "Name must not end with / and cannot be empty"
      });
      if (!newName) return;
      const devicePath = baseDevice === "/" ? `/${newName.replace(/^\//, "")}` : `${baseDevice}/${newName.replace(/^\//, "")}`;
      try {
        await mp.mkdir(devicePath);
        const relLocal = devicePath.replace(/^\//, "");
        const localPath = path.join(ws, relLocal);
        await fs.mkdir(localPath, { recursive: true });
        vscode.window.showInformationMessage(`Folder created: ${devicePath}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error creating folder: ${err?.message ?? err}`);
      }
      vscode.commands.executeCommand("mpyWorkbench.refresh");
    }),
    vscode.commands.registerCommand("mpyWorkbench.renameNode", async (node: Esp32Node) => {
      if (!node) return;
      const oldPath = node.path;
      const isDir = node.kind === "dir";
      const base = path.posix.dirname(oldPath);
      const oldName = path.posix.basename(oldPath);
      const newName = await vscode.window.showInputBox({
        prompt: `New name for ${oldName}`,
        value: oldName,
        validateInput: v => v && v !== oldName ? undefined : "Name must be different and not empty"
      });
      if (!newName || newName === oldName) return;
      const newPath = base === "/" ? `/${newName}` : `${base}/${newName}`;
      // Try to rename on board first
      try {
        await mp.mvOnDevice(oldPath, newPath);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error renaming on board: ${err?.message ?? err}`);
        return;
      }
      // Try to rename locally if file exists locally
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsFolder) {
        // Compute local path from node.path
        const relPath = node.path.replace(/^\//, "");
        const localOld = path.join(wsFolder, relPath);
        const localNew = path.join(wsFolder, base.replace(/^\//, ""), newName);
        try {
          await fs.rename(localOld, localNew);
        } catch (e) {
          // If file doesn't exist locally, ignore
        }
      }
      vscode.window.showInformationMessage(`Renamed: ${oldPath} → ${newPath}`);
      // Refresh tree
      const tree = vscode.extensions.getExtension("DanielBucam.mpy-workbench")?.exports?.esp32Tree as { refreshTree: () => void };
      if (tree && typeof tree.refreshTree === "function") tree.refreshTree();
      else vscode.commands.executeCommand("mpyWorkbench.refresh");
    })
  );
  // Auto-upload on save: if file is inside a workspace, push to device path mapped by mpyWorkbench.rootPath
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!ws) return;
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
      const rel = path.relative(ws.uri.fsPath, doc.uri.fsPath).replace(/\\/g, "/");
      try {
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        if (matcher(rel, false)) {
          // Skip auto-upload for ignored files
          return;
        }
      } catch {}
      const deviceDest = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/" + rel;
      try {
        await withAutoSuspend(() => mp.cpToDevice(doc.uri.fsPath, deviceDest));
        tree.addNode(deviceDest, false);
      }
      catch (e) {
        console.error(`[DEBUG] Auto-upload failed for ${rel}:`, e);
        vscode.window.showWarningMessage(`Board auto-upload failed for ${rel}: ${String((e as any)?.message ?? e)}`);
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal.name === "ESP32 REPL") {
        // replTerminal is now managed in mpremoteCommands.ts
      }
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
    } catch (e) {
      vscode.window.showErrorMessage('Failed to toggle workspace auto-sync: ' + String(e));
    }
  }));
}

export function deactivate() {}

// (no stray command registrations beyond this point)
/*
vscode.commands.registerCommand("mpyWorkbench.rename", async (node: Esp32Node) => {
  if (!node) return;
  const oldPath = node.path;
  const isDir = node.kind === "dir";
  const base = path.posix.dirname(oldPath);
  const oldName = path.posix.basename(oldPath);
  const newName = await vscode.window.showInputBox({
    prompt: `Nuevo nombre para ${oldName}`,
    value: oldName,
    validateInput: v => v && v !== oldName ? undefined : "El nombre debe ser diferente y no vacío"
  });
  if (!newName || newName === oldName) return;
  const newPath = base === "/" ? `/${newName}` : `${base}/${newName}`;
  try {
    if (typeof mp.rename === "function") {
      await withAutoSuspend(() => mp.rename(oldPath, newPath));
    } else if (typeof mp.mv === "function") {
      await withAutoSuspend(() => mp.mv(oldPath, newPath));
    } else {
      vscode.window.showErrorMessage("No rename/mv function found in mp.");
      return;
    }
    vscode.window.showInformationMessage(`Renombrado: ${oldPath} → ${newPath}`);
    tree.refreshTree();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Error al renombrar: ${err?.message ?? err}`);
  }
});
*/
