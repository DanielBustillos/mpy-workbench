// Disconnect the ESP32 REPL terminal but leave it open
async function disconnectReplTerminal() {
  if (replTerminal) {
    try {
      // Sequence to exit miniterm cleanly: Ctrl-] then 'q' + Enter
      replTerminal.sendText("\x1d", false); // Ctrl-]
      await new Promise(r => setTimeout(r, 120));
      replTerminal.sendText("q", false);
      await new Promise(r => setTimeout(r, 60));
      replTerminal.sendText("\r", false);
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }
}

async function restartReplInExistingTerminal() {
  if (!replTerminal) return;
  try {
    const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
    if (!connect || connect === "auto") return;
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      // Use PowerShell loop to auto-reconnect until available. Filter error stack traces.
      // Print the reconnect notice only once per session.
      getPythonCommandForTerminal().then(pythonCmd => {
        const cmd = `powershell -NoProfile -Command \"$once=$true; while ($true) { ${pythonCmd} -m serial.tools.miniterm '${device}' 115200 --raw 2>&1 | Where-Object { $_ -notmatch 'Exception in thread (rx|tx)|Traceback|SerialException|OSError:|could not open port' }; if ($once) { echo ''; echo 'Trying to reconnect ... (Ctrl+C to cancel)'; $once=$false }; Start-Sleep -Seconds 1 }\"`;
        if (replTerminal) replTerminal.sendText(cmd, true);
      }).catch(() => {
        // Fallback to python if getPythonCommandForTerminal fails
        const cmd = `powershell -NoProfile -Command \"$once=$true; while ($true) { python -m serial.tools.miniterm '${device}' 115200 --raw 2>&1 | Where-Object { $_ -notmatch 'Exception in thread (rx|tx)|Traceback|SerialException|OSError:|could not open port' }; if ($once) { echo ''; echo 'Trying to reconnect ... (Ctrl+C to cancel)'; $once=$false }; Start-Sleep -Seconds 1 }\"`;
        if (replTerminal) replTerminal.sendText(cmd, true);
      });
    } else {
      // Loop forever: rerun miniterm on disconnect, allow Ctrl+C to stop; filter traceback blocks.
      // Print the reconnect notice only once per session.
      getPythonCommandForTerminal().then(pythonCmd => {
        const cmd = `shown=0; while true; do ( ${pythonCmd} -m serial.tools.miniterm ${device} 115200 --raw 2>&1 | awk 'BEGIN{skip=0}
$0 ~ /^--- Miniterm on /{skip=0; print; next}
$0 ~ /^--- Quit:/{skip=0; print; next}
$0 ~ /^Exception in thread [rt]x:/{skip=1;next}
index($0, "Traceback (most recent call last):")==1 {skip=1;next}
index($0, "During handling of the above exception, another exception occurred:")==1 {skip=1;next}
skip && $0 ~ /^$/{skip=0;next}
$0 ~ /^--- exit ---$/{next}
index($0, "could not open port ")==1 {next}
index($0, "SerialException: read failed:") {next}
index($0, "OSError: [Errno 6] Device not configured") {next}
index($0, "os.read(") {next}
/^[[:space:]]*[\\^]+$/ {next}
index($0, "serial/tools/miniterm.py") {next}
index($0, "serial/serialposix.py") {next}
index($0, "/threading.py") {next}
skip==0 {print}' ); if [ $shown -eq 0 ]; then echo; echo 'Trying to reconnect ... (Ctrl+C to cancel)'; shown=1; fi; sleep 1; done`;
        if (replTerminal) replTerminal.sendText(cmd, true);
      }).catch(() => {
        // Fallback to python3 if getPythonCommandForTerminal fails
        const cmd = `shown=0; while true; do ( python3 -m serial.tools.miniterm ${device} 115200 --raw 2>&1 | awk 'BEGIN{skip=0}
$0 ~ /^--- Miniterm on /{skip=0; print; next}
$0 ~ /^--- Quit:/{skip=0; print; next}
$0 ~ /^Exception in thread [rt]x:/{skip=1;next}
index($0, "Traceback (most recent call last):")==1 {skip=1;next}
index($0, "During handling of the above exception, another exception occurred:")==1 {skip=1;next}
skip && $0 ~ /^$/{skip=0;next}
$0 ~ /^--- exit ---$/{next}
index($0, "could not open port ")==1 {next}
index($0, "SerialException: read failed:") {next}
index($0, "OSError: [Errno 6] Device not configured") {next}
index($0, "os.read(") {next}
/^[[:space:]]*[\\^]+$/ {next}
index($0, "serial/tools/miniterm.py") {next}
index($0, "serial/serialposix.py") {next}
index($0, "/threading.py") {next}
skip==0 {print}' ); if [ $shown -eq 0 ]; then echo; echo 'Trying to reconnect ... (Ctrl+C to cancel)'; shown=1; fi; sleep 1; done`;
        if (replTerminal) replTerminal.sendText(cmd, true);
      });
    }
    await new Promise(r => setTimeout(r, 200));
  } catch {}
}
import * as vscode from "vscode";
import { Esp32Tree } from "./esp32Fs";
import { ActionsTree } from "./actions";
import { SyncTree } from "./syncView";
import { Esp32Node } from "./types";
import * as mp from "./mpremote";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec } from "node:child_process";
import { buildManifest, diffManifests, saveManifest, loadManifest, defaultIgnorePatterns, createIgnoreMatcher, Manifest } from "./sync";
import { Esp32DecorationProvider } from "./decorations";
import { listDirPyRaw } from "./pyraw";
import { getPythonPath, getPythonCommandForTerminal, clearPythonCache, checkPyserialAvailability } from "./pythonInterpreter";
// import { monitor } from "./monitor"; // switched to auto-suspend REPL strategy

export function activate(context: vscode.ExtensionContext) {
  // Validate Python dependencies on extension activation
  const { execFile } = require('node:child_process');
  const pyScript = path.join(context.extensionPath, 'scripts', 'check_python_deps.py');

  // Use the configured Python interpreter for dependency check
  getPythonPath().then(pythonPath => {
    execFile(pythonPath, [pyScript], (err: any, stdout: Buffer, stderr: Buffer) => {
      const out = String(stdout || '').trim();
      if (out === 'ok') return;
      vscode.window.showWarningMessage('Missing dependency: pyserial. Install pyserial in the Python environment used by the extension to detect ports and communicate with the device.');
    });
  }).catch(error => {
    vscode.window.showWarningMessage(`Error checking Python dependencies: ${error.message}`);
  });

  // Check pyserial availability proactively
  checkPyserialAvailability().catch(error => {
    console.log('Error during pyserial availability check:', error);
  });
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
      '.mpyignore',
      ''
    ].join('\n');
  }

  // Ensure a root-level .mpyignore exists with sensible defaults
  async function ensureRootIgnoreFile(wsPath: string) {
    const ignorePath = path.join(wsPath, '.mpyignore');
    try {
      // If exists, upgrade only if it's the placeholder header with no rules
      const txt = await fs.readFile(ignorePath, 'utf8');
      const nonComment = txt.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const hasOldHeader = /Ignore patterns for MPY Workbench/.test(txt);
      if (hasOldHeader && nonComment.length === 0) {
        try { await fs.writeFile(ignorePath, buildDefaultMpyIgnoreContent(), 'utf8'); } catch {}
      }
      return; // file exists; keep user rules otherwise
    } catch {
      // Not exists: create with defaults
      try { await fs.writeFile(ignorePath, buildDefaultMpyIgnoreContent(), 'utf8'); } catch {}
    }
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
      ensureRootIgnoreFile(ws.uri.fsPath).catch(() => {});
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
      mp.setSerialNoticeSuppressed(true);
      try { return await fn(); }
      finally { mp.setSerialNoticeSuppressed(false); }
    }
    opQueue = opQueue.catch(() => {}).then(async () => {
      const wasOpen = isReplOpen();
      if (wasOpen) await disconnectReplTerminal();
      try {
        mp.setSerialNoticeSuppressed(true);
        await ensureIdle();
        return await fn();
      } finally {
        mp.setSerialNoticeSuppressed(false);
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
    vscode.commands.registerCommand("mpyWorkbench.pickPort", async () => {
      // Always get the most recent port list before showing the selector
      const ports = await mp.listSerialPorts();
      const items: vscode.QuickPickItem[] = [
        { label: "auto", description: "Auto-detect device" },
        ...ports.map(p => ({ label: p, description: "serial port" }))
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
    vscode.commands.registerCommand("mpyWorkbench.serialSendCtrlC", async () => {
      const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
      if (!connect || connect === "auto") { vscode.window.showWarningMessage("Select a specific serial port first (not 'auto')."); return; }
      // Prefer using REPL terminal if open to avoid port conflicts and return to friendly REPL
      if (isReplOpen()) {
        try {
          const term = await getReplTerminal(context);
          term.sendText("\x03", false); // Ctrl-C interrupt
          await new Promise(r => setTimeout(r, 60));
          term.sendText("\x02", false); // Ctrl-B friendly REPL
          vscode.window.showInformationMessage("Board: Interrupt sequence (Ctrl-C, Ctrl-B) sent via REPL");
          return;
        } catch {}
      }
      // Fallback: write directly to serial device
      const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
      const isMac = process.platform === 'darwin';
      const sttyCmd = isMac ? `stty -f ${device} 115200` : `stty -F ${device} 115200`;
      const cmd = `${sttyCmd} && printf '\\x03\\x02' > ${device}`;
      await new Promise<void>((resolve) => {
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            vscode.window.showErrorMessage(`Board: Interrupt sequence failed: ${stderr || error.message}`);
          } else {
            vscode.window.showInformationMessage(`Board: Interrupt sequence (Ctrl-C, Ctrl-B) sent to ${device}`);
          }
          resolve();
        });
      });
      // No auto-refresh here
    }),
    vscode.commands.registerCommand("mpyWorkbench.stop", async () => {
      const cfg = vscode.workspace.getConfiguration();
      const connect = cfg.get<string>("mpyWorkbench.connect", "auto");
      if (!connect || connect === "auto") { vscode.window.showWarningMessage("Select a specific serial port first (not 'auto')."); return; }
      const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
      // If REPL terminal is open, prefer sending through it to avoid port conflicts
      if (isReplOpen()) {
        try {
          const term = await getReplTerminal(context);
          term.sendText("\x03", false); // Ctrl-C
          await new Promise(r => setTimeout(r, 60));
          term.sendText("\x01", false); // Ctrl-A (raw repl)
          await new Promise(r => setTimeout(r, 60));
          term.sendText("\x04", false); // Ctrl-D (soft reboot)
          vscode.window.showInformationMessage("Board: Stop sequence sent via REPL");
          return;
        } catch (e: any) {
          // fall back to writing to device below
        }
      }
      const isMac2 = process.platform === 'darwin';
      const sttyCmd2 = isMac2 ? `stty -f ${device} 115200` : `stty -F ${device} 115200`;
      const cmd2 = `${sttyCmd2} && printf '\\x03\\x01\\x04' > ${device}`;
      await new Promise<void>((resolve) => {
        exec(cmd2, (error, stdout, stderr) => {
          if (error) {
            vscode.window.showErrorMessage(`Board: Stop sequence failed: ${stderr || error.message}`);
          } else {
            vscode.window.showInformationMessage(`Board: Stop sequence sent to ${device}`);
          }
          resolve();
        });
      });
    }),
    vscode.commands.registerCommand("mpyWorkbench.softReset", async () => {
      const cfg = vscode.workspace.getConfiguration();
      const connect = cfg.get<string>("mpyWorkbench.connect", "auto");
      if (!connect || connect === "auto") { vscode.window.showWarningMessage("Select a specific serial port first (not 'auto')."); return; }
      const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
      // If REPL terminal is open, prefer sending through it to avoid port conflicts
      if (isReplOpen()) {
        try {
          const term = await getReplTerminal(context);
          term.sendText("\x03", false); // Ctrl-C
          await new Promise(r => setTimeout(r, 60));
          term.sendText("\x02", false); // Ctrl-B (friendly REPL)
          await new Promise(r => setTimeout(r, 80));
          term.sendText("\x04", false); // Ctrl-D (soft reset)
          vscode.window.showInformationMessage("Board: Soft reset sent via ESP32 REPL");
          return;
        } catch {
          // fall back to writing to device below
        }
      }
      const isMac = process.platform === 'darwin';
      const sttyCmd = isMac ? `stty -f ${device} 115200` : `stty -F ${device} 115200`;
      const cmd = `${sttyCmd} && printf '\\x03\\x02\\x04' > ${device}`;
      await new Promise<void>((resolve) => {
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            vscode.window.showErrorMessage(`Board: Soft reset failed: ${stderr || error.message}`);
          } else {
            vscode.window.showInformationMessage(`Board: Soft reset (Ctrl-D) sent to ${device}`);
          }
          resolve();
        });
      });
    }),

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
            await withAutoSuspend(() => mp.cpToDevice(abs, devicePath));
            vscode.window.showInformationMessage(`File saved locally and uploaded to board: ${filename}`);
            tree.addNode(devicePath, false);
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
          await ensureRootIgnoreFile(ws.uri.fsPath);
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

        // Upload all files with progress
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "Uploading all files to board...",
          cancellable: false
        }, async (progress, token) => {
          const files = Object.keys(man.files);
          let uploaded = 0;
          const total = files.length;

          if (total === 0) {
            progress.report({ increment: 100, message: "No files to upload" });
            return;
          }

          progress.report({ increment: 0, message: `Found ${total} files to upload` });

          await withAutoSuspend(async () => {
            for (const relativePath of files) {
              const localPath = path.join(ws.uri.fsPath, relativePath);
              const devicePath = path.posix.join(rootPath, relativePath);

              progress.report({
                increment: (100 / total),
                message: `Uploading ${relativePath} (${++uploaded}/${total})`
              });
  
              // Ensure directory exists on device
              const deviceDir = path.posix.dirname(devicePath);
              if (deviceDir !== '.' && deviceDir !== rootPath) {
                try {
                  await mp.mkdir(deviceDir);
                  tree.addNode(deviceDir, true); // Add folder to tree
                } catch {
                  // Directory might already exist, ignore error
                }
              }
              await mp.uploadReplacing(localPath, devicePath);
              tree.addNode(devicePath, false); // Add file to tree
            }
          });
        });

        // Save manifest locally and on device
        const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
        await saveManifest(manifestPath, man);
        const tmp = path.join(context.globalStorageUri.fsPath, "esp32sync.json");
        await fs.mkdir(path.dirname(tmp), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(man));
        const deviceManifest = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/.mpy-workbench/esp32sync.json";
        await withAutoSuspend(() => mp.cpToDevice(tmp, deviceManifest));

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



    vscode.commands.registerCommand("mpyWorkbench.openSerial", async () => {
      await openReplTerminal(context);
    }),
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
      // Clear Python interpreter cache when Python configuration changes
      if (e.affectsConfiguration('python.defaultInterpreterPath') ||
          e.affectsConfiguration('python.pythonPath') ||
          e.affectsConfiguration('mpyWorkbench.pythonPath')) {
        clearPythonCache();
      }
    }),

    // Listen for Python extension activation/deactivation to clear cache
    vscode.extensions.onDidChange(() => {
      const pythonExtension = vscode.extensions.getExtension('ms-python.python');
      if (pythonExtension && pythonExtension.isActive) {
        // Clear cache when Python extension becomes active
        clearPythonCache();
      }
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
      await withAutoSuspend(() => mp.uploadReplacing(ed.document.uri.fsPath, dest));
      tree.addNode(dest, false);
      vscode.window.showInformationMessage(`Uploaded to ${dest}`);
      tree.refreshTree();
    }),
    vscode.commands.registerCommand("mpyWorkbench.runActiveFile", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("No active editor"); return; }
      await ed.document.save();
      // If the REPL terminal is open, close it before executing
      if (isReplOpen()) {
        await closeReplTerminal();
        // Wait for the system to release the port
        await new Promise(r => setTimeout(r, 400));
      }
      // Intenta abrir la terminal REPL
      try {
        await openReplTerminal(context);
      } catch (err) {
        vscode.window.showErrorMessage("Could not open REPL terminal. The port may be busy or disconnected. Close any processes using the port and try again.");
        return;
      }
      const term = await getReplTerminal(context);
      // Longer pause to avoid Ctrl-* being treated as host signals before miniterm takes control
      await new Promise(r => setTimeout(r, 600));
      // Enter RAW REPL (no input echo). Avoid Ctrl-C here as it may generate KeyboardInterrupt in miniterm if not ready yet
      term.sendText("\x01", false); // Ctrl-A (raw REPL)
      await new Promise(r => setTimeout(r, 150));
      // Send the complete file content; in RAW REPL the text is not shown
      const text = ed.document.getText().replace(/\r\n/g, "\n");
      term.sendText(text, true);
      // Finalize and execute
      term.sendText("\x04", false); // Ctrl-D (execute in raw)
      // Return to friendly REPL after a small interval
      await new Promise(r => setTimeout(r, 200));
      term.sendText("\x02", false); // Ctrl-B (friendly REPL)
    }),
    vscode.commands.registerCommand("mpyWorkbench.checkDiffs", async () => {
        // ...existing code...
        const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
        // Helper to convert local relative path to absolute path on board
        const toDevicePath = (localRel: string) => {
          const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
          if (normRoot === "/") return "/" + localRel;
          return localRel === "" ? normRoot : normRoot + "/" + localRel;
        };
      // Close the REPL terminal if open to avoid port conflicts
      if (isReplOpen()) {
        await disconnectReplTerminal();
        await new Promise(r => setTimeout(r, 400));
      }
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Checking file differences...",
        cancellable: false
      }, async (progress) => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) { vscode.window.showErrorMessage("No workspace folder open"); return; }
        // Check if workspace is initialized for sync
        const initialized = await isLocalSyncInitialized();
        if (!initialized) {
          const initialize = await vscode.window.showWarningMessage(
            "The local folder is not initialized for synchronization. Would you like to initialize it now?",
            { modal: true },
            "Initialize"
          );
          if (initialize !== "Initialize") return;
          // Create initial manifest to initialize sync
          await ensureRootIgnoreFile(ws.uri.fsPath);
          await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
          const matcher = await createIgnoreMatcher(ws.uri.fsPath);
          const initialManifest = await buildManifest(ws.uri.fsPath, matcher);
          const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
          await saveManifest(manifestPath, initialManifest);
          vscode.window.showInformationMessage("Local folder initialized for synchronization.");
        }
        const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
        progress.report({ message: "Reading board files..." });
        const relFromDevice = (devicePath: string) => {
          const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
          if (normRoot === "/") return devicePath.replace(/^\//, "");
          if (devicePath.startsWith(normRoot + "/")) return devicePath.slice(normRoot.length + 1);
          if (devicePath === normRoot) return "";
          return devicePath.replace(/^\//, "");
        };
        // Apply ignore/filters locally before comparing
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const localManifest = await buildManifest(ws.uri.fsPath, matcher);
        // Only local files that are not ignored
        const localFiles = Object.keys(localManifest.files);
        // Obtén listado del board
        const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        const deviceFiles = deviceStats.filter(e => !e.isDir);
        // Apply ignore rules to device files too, so ignored files/dirs don't produce false diffs
        const deviceFilesFiltered = deviceFiles.filter(f => {
          const rel = relFromDevice(f.path);
          return !matcher(rel, false);
        });
        const deviceFileMap = new Map(deviceFilesFiltered.map(f => [relFromDevice(f.path), f]));
        const diffSet = new Set<string>();

        progress.report({ message: "Comparing files..." });
        // Compara solo archivos locales no ignorados
        for (const localRel of localFiles) {
          const deviceFile = deviceFileMap.get(localRel);
          const abs = path.join(ws.uri.fsPath, ...localRel.split('/'));
          if (deviceFile) {
            try {
              const st = await fs.stat(abs);
              // Consider files the same if sizes match (ignore mtime skew on device)
              const same = st.size === deviceFile.size;
              if (!same) diffSet.add(deviceFile.path);
            } catch {
              diffSet.add(deviceFile.path);
            }
          }
        }

        // Files on board that don't exist locally (not ignored)
        for (const [rel, deviceFile] of deviceFileMap.entries()) {
          if (!localFiles.includes(rel)) {
            diffSet.add(deviceFile.path);
          }
        }

        progress.report({ message: "Checking local files..." });
        // Files that exist locally but not on board
        const localOnlySet = new Set<string>();
        for (const localRel of localFiles) {
          const deviceFile = deviceFileMap.get(localRel);
          if (!deviceFile) {
            // Only add if not ignored
            localOnlySet.add(toDevicePath(localRel));
          }
        }
        
        progress.report({ message: "Processing differences..." });
        // Keep original sets for sync operations (files only)
        const originalDiffSet = new Set(diffSet);
        const originalLocalOnlySet = new Set(localOnlySet);
        
        // Mark parent dirs for any differing children (for decorations only)
        const parents = new Set<string>();
        for (const p of diffSet) {
          let cur = p;
          while (cur.includes('/')) {
            cur = cur.substring(0, cur.lastIndexOf('/')) || '/';
            parents.add(cur);
            if (cur === '/' || cur === rootPath) break;
          }
        }
        for (const d of parents) diffSet.add(d);
        
        // Mark parent dirs for local-only files too (for decorations only)
        for (const p of localOnlySet) {
          let cur = p;
          while (cur.includes('/')) {
            cur = cur.substring(0, cur.lastIndexOf('/')) || '/';
            parents.add(cur);
            if (cur === '/' || cur === rootPath) break;
          }
        }
        for (const d of parents) localOnlySet.add(d);
        
        // Set decorations with parent directories included
        decorations.setDiffs(diffSet);
        decorations.setLocalOnly(localOnlySet);
        
        // Store original file-only sets for sync operations
        (decorations as any)._originalDiffs = originalDiffSet;
        (decorations as any)._originalLocalOnly = originalLocalOnlySet;
        
        // Debug: Log what was found
        console.log("Debug - checkDiffs results:");
        console.log("- diffSet:", Array.from(diffSet));
        console.log("- localOnlySet:", Array.from(localOnlySet));
        console.log("- deviceFiles count:", deviceFiles.length, "(filtered:", deviceFilesFiltered.length, ")");
        console.log("- localManifest files count:", Object.keys(localManifest.files).length);
        
        // Refresh the tree view to show local-only files
        tree.refreshTree();
        
        const changedFilesCount = (decorations as any)._originalDiffs ? (decorations as any)._originalDiffs.size : Array.from(diffSet).filter(p => !p.endsWith('/')).length;
        const localOnlyFilesCount = (decorations as any)._originalLocalOnly ? (decorations as any)._originalLocalOnly.size : Array.from(localOnlySet).filter(p => !p.endsWith('/')).length;
        const totalFilesFlagged = changedFilesCount + localOnlyFilesCount;
        vscode.window.showInformationMessage(
          `Board: Diff check complete (${changedFilesCount} changed, ${localOnlyFilesCount} local-only, ${totalFilesFlagged} total files)`
        );
      });
    }),
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
        await ensureRootIgnoreFile(ws.uri.fsPath);
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
        await ensureRootIgnoreFile(ws2.uri.fsPath);
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
        // If not present locally, fetch from device to local path
        try { await fs.access(abs); } catch { await withAutoSuspend(() => mp.cpFromDevice(node.path, abs)); }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: false });
        await context.workspaceState.update("mpyWorkbench.lastOpenedPath", abs);
      } else {
        // Fallback: no workspace, use temp
        const temp = vscode.Uri.joinPath(context.globalStorageUri, node.path.replace(/\//g, "_"));
        await fs.mkdir(path.dirname(temp.fsPath), { recursive: true });
        await withAutoSuspend(() => mp.cpFromDevice(node.path, temp.fsPath));
        const doc = await vscode.workspace.openTextDocument(temp);
        await vscode.window.showTextDocument(doc, { preview: true });
        await context.workspaceState.update("mpyWorkbench.lastOpenedPath", temp.fsPath);
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
        await mp.uploadReplacing(localPath, devicePath);
        vscode.window.showInformationMessage(`File created: ${devicePath}`);
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
      try { await withAutoSuspend(() => mp.cpToDevice(doc.uri.fsPath, deviceDest)); tree.addNode(deviceDest, false); }
      catch (e) { vscode.window.showWarningMessage(`Board auto-upload failed for ${rel}: ${String((e as any)?.message ?? e)}`); }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === replTerminal || terminal.name === "ESP32 REPL") {
        replTerminal = undefined;
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

let replTerminal: vscode.Terminal | undefined;
async function getReplTerminal(context: vscode.ExtensionContext): Promise<vscode.Terminal> {
  if (replTerminal) {
    const alive = vscode.window.terminals.some(t => t === replTerminal);
    if (alive) return replTerminal;
    replTerminal = undefined;
  }
  const connect = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.connect", "auto");
  const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    // Windows: keep trying to reconnect using PowerShell loop; filter error stack traces. Ctrl+C to stop.
    // Print reconnect notice only once per session.
    const pythonCmd = await getPythonCommandForTerminal().catch(() => 'python');
    const cmd = `powershell -NoProfile -Command "${pythonCmd} -c 'import serial' 2>$null; if ($LASTEXITCODE -ne 0) { echo 'ERROR: pyserial not installed. Install with: pip install pyserial' }; $once=$true; while ($true) { ${pythonCmd} -m serial.tools.miniterm ${device} 115200 --eol LF 2>&1 | Where-Object { $_ -notmatch '^--- exit ---|Exception in thread (rx|tx)|Traceback|SerialException|OSError:|could not open port|During handling of the above exception|os.read\(' }; if ($once) { echo ''; echo 'Trying to reconnect ... (Ctrl+C to cancel)'; $once=$false }; Start-Sleep -Seconds 1 }"`;
    replTerminal = vscode.window.createTerminal({
      name: "ESP32 REPL",
      shellPath: "cmd.exe",
      shellArgs: ["/d", "/c", cmd]
    });
  } else {
    // macOS/Linux: try multiple Python commands; loop to auto-reconnect; filter traceback blocks; Ctrl+C to stop.
    const userShell = process.env.SHELL || '/bin/bash';
    const awkFilter = `awk 'BEGIN{skip=0}
$0 ~ /^--- Miniterm on /{skip=0; print; next}
$0 ~ /^--- Quit:/{skip=0; print; next}
$0 ~ /^Exception in thread [rt]x:/{skip=1;next}
index($0, "Traceback (most recent call last):")==1 {skip=1;next}
index($0, "During handling of the above exception, another exception occurred:")==1 {skip=1;next}
skip && $0 ~ /^$/{skip=0;next}
$0 ~ /^--- exit ---$/{next}
index($0, "could not open port ")==1 {next}
index($0, "SerialException: read failed:") {next}
index($0, "OSError: [Errno 6] Device not configured") {next}
index($0, "os.read(") {next}
/^[[:space:]]*[\\^]+$/ {next}
index($0, "serial/tools/miniterm.py") {next}
index($0, "serial/serialposix.py") {next}
index($0, "/threading.py") {next}
skip==0 {print}'`;
    const pythonCmd = await getPythonCommandForTerminal().catch(() => 'python3');
    const cmd = `ANNOUNCED=0; TRIED=0; while true; do if ${pythonCmd} -c "import serial" 2>/dev/null; then ${pythonCmd} -m serial.tools.miniterm ${device} 115200 --eol LF 2>&1 | ${awkFilter}; elif python -c "import serial" 2>/dev/null; then python -m serial.tools.miniterm ${device} 115200 --eol LF 2>&1 | ${awkFilter}; elif /usr/bin/python3 -c "import serial" 2>/dev/null; then /usr/bin/python3 -m serial.tools.miniterm ${device} 115200 --eol LF 2>&1 | ${awkFilter}; else echo; echo "ERROR: pyserial not found in any Python installation."; echo "Try installing with one of:"; echo "  pip3 install pyserial"; echo "  python3 -m pip install pyserial"; echo "Available Pythons:"; which python3 python /usr/bin/python3 2>/dev/null || echo "  None found"; fi; if [ $TRIED -eq 0 ]; then echo; echo 'Trying to reconnect ... (Ctrl+C to cancel)'; TRIED=1; fi; sleep 1; done`;
    replTerminal = vscode.window.createTerminal({
      name: "ESP32 REPL",
      shellPath: userShell,
      shellArgs: ["-lc", cmd]
    });
  }
  return replTerminal;
}

function isReplOpen(): boolean {
  if (!replTerminal) return false;
  return vscode.window.terminals.some(t => t === replTerminal);
}

async function closeReplTerminal() {
  if (replTerminal) {
    try {
      replTerminal.dispose();
    } catch {}
    replTerminal = undefined;
    await new Promise(r => setTimeout(r, 300));
  }
}

async function openReplTerminal(context: vscode.ExtensionContext) {
  // Strict handshake like Thonny: ensure device is interrupted and responsive before opening REPL
  const cfg = vscode.workspace.getConfiguration();
  const interrupt = cfg.get<boolean>("mpyWorkbench.interruptOnConnect", true);
  const strict = cfg.get<boolean>("mpyWorkbench.strictConnect", true);
  let lastError: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (strict) {
        await strictConnectHandshake(interrupt);
      } else if (interrupt) {
        try { await mp.reset(); } catch {}
      }
      const term = await getReplTerminal(context);
      term.show(true);
      // tiny delay to ensure terminal connects before next action
      await new Promise(r => setTimeout(r, 150));
      return;
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err).toLowerCase();
      if (
        msg.includes("device not configured") ||
        msg.includes("serialexception") ||
        msg.includes("serial port not found") ||
        msg.includes("read failed")
      ) {
        // Wait and retry once
        if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
        else throw err;
      } else {
        throw err;
      }
    }
  }
  if (lastError) throw lastError;
}

async function strictConnectHandshake(interrupt: boolean) {
  // Try reset + quick op, retry once if needed
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (interrupt) await mp.reset();
      // quick check: ls root; if it returns without throwing, we assume we're good
      await mp.ls("/");
      return;
    } catch (e) {
      if (attempt === 2) break;
      // small backoff then retry
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

function toLocalRelative(devicePath: string, rootPath: string): string {
  const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
  if (normRoot === "/") return devicePath.replace(/^\//, "");
  if (devicePath.startsWith(normRoot + "/")) return devicePath.slice(normRoot.length + 1);
  if (devicePath === normRoot) return "";
  // Fallback: strip leading slash
  return devicePath.replace(/^\//, "");
}
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
