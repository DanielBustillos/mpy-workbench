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
// import { monitor } from "./monitor"; // switched to auto-suspend REPL strategy

export function activate(context: vscode.ExtensionContext) {
  // Validar dependencias Python al activar la extensión
  const { execFile } = require('node:child_process');
  const pyScript = path.join(context.extensionPath, 'scripts', 'check_python_deps.py');
  execFile('python3', [pyScript], (err: any, stdout: Buffer, stderr: Buffer) => {
    const out = String(stdout || '').trim();
    if (out === 'ok') return;
    vscode.window.showWarningMessage('Dependencia faltante: pyserial. Instala pyserial en el entorno Python usado por la extensión para detectar puertos y comunicar con el dispositivo.');
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
      const content = `# Ignore patterns for MPY Workbench (gitignore-style)\n# These paths are relative to your workspace root. Examples:\n# build/\n# secret.json\n# **/*.log\n`;
      try { await fs.writeFile(path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore'), content, 'utf8'); } catch {}
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
      if (wasOpen) await closeReplTerminal();
      try {
        mp.setSerialNoticeSuppressed(true);
        await ensureIdle();
        return await fn();
      } finally {
        mp.setSerialNoticeSuppressed(false);
        if (wasOpen) await openReplTerminal(context);
      }
    });
    return opQueue as Promise<T>;
  }
  context.subscriptions.push(
    view,
    actionsView,
    syncView,
    vscode.commands.registerCommand("mpyWorkbench.refresh", () => { 
      // On refresh, only issue the mpremote list without extra control signals
  tree.enableRawListForNext();
  tree.refreshTree();
    }),
    vscode.commands.registerCommand("mpyWorkbench.pickPort", async () => {
      // Siempre obtener la lista más reciente de puertos antes de mostrar el selector
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

    vscode.commands.registerCommand("mpyWorkbench.newFileBoardAndLocal", async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }
      const rootPath = vscode.workspace.getConfiguration().get<string>("mpyWorkbench.rootPath", "/");
      const filename = await vscode.window.showInputBox({
        prompt: "Nombre del nuevo archivo (relativo a la raíz del proyecto)",
        placeHolder: "main.py, lib/utils.py, ..."
      });
      if (!filename || filename.endsWith("/")) return;
      const abs = path.join(ws.uri.fsPath, ...filename.split("/"));
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, "", { flag: "wx" });
      } catch (e: any) {
        if (e.code !== "EEXIST") {
          vscode.window.showErrorMessage("No se pudo crear el archivo: " + e.message);
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
            vscode.window.showInformationMessage(`Archivo guardado (ignorado para subir): ${filename}`);
          } else {
            await withAutoSuspend(() => mp.cpToDevice(abs, devicePath));
            vscode.window.showInformationMessage(`Archivo guardado en local y subido al board: ${filename}`);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Error al subir archivo al board: ${err?.message ?? err}`);
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
  tree.refreshTree();
  // (no prompt) just refresh the tree after setting port
    }),

    vscode.commands.registerCommand("mpyWorkbench.syncBaseline", async () => {
      try {
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
              } catch {
                // Directory might already exist, ignore error
              }
            }
            
            await mp.uploadReplacing(localPath, devicePath);
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
        tree.refreshTree();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Upload failed: ${error?.message ?? String(error)}`);
      }
    }),

    vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoard", async () => {
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
          }
        });
      });
  vscode.window.showInformationMessage("Board: Sync all files (Board → Local) completed");
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
  vscode.window.showInformationMessage("Board: REPL closed");
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
      await withAutoSuspend(() => mp.uploadReplacing(ed.document.uri.fsPath, dest));
      vscode.window.showInformationMessage(`Uploaded to ${dest}`);
    }),
    vscode.commands.registerCommand("mpyWorkbench.runActiveFile", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("No active editor"); return; }
      await ed.document.save();
      // Open/show the REPL terminal with strict handshake to avoid race conditions
      await openReplTerminal(context);
      const term = await getReplTerminal(context);
      // Pausa mayor para evitar que Ctrl-* se trate como señal del host antes de que miniterm tome control
      await new Promise(r => setTimeout(r, 600));
      // Entrar en RAW REPL (no eco de entrada). Evitar Ctrl-C aquí porque puede generar KeyboardInterrupt en miniterm si aún no está listo
      term.sendText("\x01", false); // Ctrl-A (raw REPL)
      await new Promise(r => setTimeout(r, 150));
      // Send the complete file content; in RAW REPL the text is not shown
      const text = ed.document.getText().replace(/\r\n/g, "\n");
      term.sendText(text, true);
      // Finalizar y ejecutar
      term.sendText("\x04", false); // Ctrl-D (ejecutar en raw)
      // Volver al REPL amigable tras un pequeño intervalo
      await new Promise(r => setTimeout(r, 200));
      term.sendText("\x02", false); // Ctrl-B (friendly REPL)
    }),
    vscode.commands.registerCommand("mpyWorkbench.checkDiffs", async () => {
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

        const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        const deviceFiles = deviceStats.filter(e => !e.isDir);
        const diffSet = new Set<string>();
        
        progress.report({ message: "Comparing files..." });
        for (const f of deviceFiles) {
          const rel = relFromDevice(f.path);
          const abs = path.join(ws.uri.fsPath, ...rel.split('/'));
          try {
            const st = await fs.stat(abs);
            const same = st.size === f.size; // mtime across fs may be unreliable; size is a good first pass
            if (!same) diffSet.add(f.path);
          } catch { // missing locally
            diffSet.add(f.path);
          }
        }
        
        progress.report({ message: "Checking local files..." });
        // Check for files that exist locally but not on board
        const localOnlySet = new Set<string>();
        const toDevicePath = (localRel: string) => {
          const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
          if (normRoot === "/") return "/" + localRel;
          return localRel === "" ? normRoot : normRoot + "/" + localRel;
        };
        
        // Get all local files using the existing manifest/ignore system
        const matcher = await createIgnoreMatcher(ws.uri.fsPath);
        const localManifest = await buildManifest(ws.uri.fsPath, matcher);
        const deviceFileSet = new Set(deviceFiles.map(f => f.path));
        
        for (const localRel of Object.keys(localManifest.files)) {
          const devicePath = toDevicePath(localRel);
          if (!deviceFileSet.has(devicePath)) {
            localOnlySet.add(devicePath);
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
        console.log("- deviceFiles count:", deviceFiles.length);
        console.log("- localManifest files count:", Object.keys(localManifest.files).length);
        
        // Refresh the tree view to show local-only files
        tree.refreshTree();
        
        const totalFlagged = diffSet.size + localOnlySet.size;
        vscode.window.showInformationMessage(
          `Board: Diff check complete (${diffSet.size} changed, ${localOnlySet.size} local-only, ${totalFlagged} total flagged)`
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
          }
        });
      });
      decorations.clear();
      const diffCount = diffs.length;
      const localOnlyCount = localOnlyFiles.length;
      const message = localOnlyCount > 0 
        ? `Board: ${diffCount} changed and ${localOnlyCount} new files uploaded to board`
        : `Board: ${diffCount} diffed files uploaded to board`;
      vscode.window.showInformationMessage(message + " and marks cleared");
      tree.refreshTree();
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
  tree.refreshTree();
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
          // Verify that the file exists before trying to delete it
          progress.report({ increment: 20, message: "Checking file info..." });
          const fileInfo = await withAutoSuspend(() => mp.getFileInfo(node.path));
          
          if (!fileInfo) {
            progress.report({ increment: 100, message: "File not found!" });
            vscode.window.showWarningMessage(`File ${node.path} does not exist on board`);
            return;
          }
          
          progress.report({ increment: 40, message: "Connecting to board..." });
          if (fileInfo.isDir) {
            progress.report({ increment: 60, message: "Removing directory and contents..." });
            await withAutoSuspend(() => mp.deleteFolderRecursive(node.path));
          } else {
            progress.report({ increment: 60, message: "Removing file..." });
            await withAutoSuspend(() => mp.deleteFile(node.path));
          }
          
          // Verify that the file was deleted (with retries)
          progress.report({ increment: 80, message: "Verifying deletion..." });
          
          let existsAfter = true;
          let attempts = 0;
          const maxAttempts = 3;
          
          while (existsAfter && attempts < maxAttempts) {
            attempts++;
            if (attempts > 1) {
              // Wait a bit before next attempt
              await delay(200);
            }
            
            try {
              existsAfter = await withAutoSuspend(() => mp.fileExists(node.path));
            } catch (error) {
              // If there's an error verifying, assume it was deleted
              existsAfter = false;
              break;
            }
          }
          
          if (existsAfter) {
            progress.report({ increment: 100, message: "Deletion verification failed!" });
            vscode.window.showWarningMessage(`${node.path} was processed but verification failed. Please refresh to check if it was deleted.`);
          } else {
            progress.report({ increment: 100, message: "Deletion complete!" });
            vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
          }
        } catch (err: any) {
          progress.report({ increment: 100, message: "Deletion failed!" });
          vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
        }
      });
      
      tree.refreshTree();
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
          // Verify that the file exists before trying to delete it
          progress.report({ increment: 10, message: "Checking file info..." });
          const fileInfo = await withAutoSuspend(() => mp.getFileInfo(node.path));
          
          if (!fileInfo) {
            progress.report({ increment: 50, message: "File not found on board, continuing with local..." });
            vscode.window.showWarningMessage(`File ${node.path} does not exist on board, deleting only local copy`);
          } else {
            progress.report({ increment: 30, message: "Connecting to board..." });
            if (fileInfo.isDir) {
              progress.report({ increment: 50, message: "Removing directory from board..." });
              await withAutoSuspend(() => mp.deleteFolderRecursive(node.path));
            } else {
              progress.report({ increment: 50, message: "Removing file from board..." });
              await withAutoSuspend(() => mp.deleteFile(node.path));
            }
            
            // Verify that the file was deleted from board (with retries)
            let existsAfter = true;
            let attempts = 0;
            const maxAttempts = 3;
            
            while (existsAfter && attempts < maxAttempts) {
              attempts++;
              if (attempts > 1) {
                // Wait a bit before next attempt
                await delay(200);
              }
              
              try {
                existsAfter = await withAutoSuspend(() => mp.fileExists(node.path));
              } catch (error) {
                // If there's an error verifying, assume it was deleted
                existsAfter = false;
                break;
              }
            }
            
            if (existsAfter) {
              progress.report({ increment: 60, message: "Board deletion verification failed!" });
              vscode.window.showWarningMessage(`${node.path} was processed but verification failed. Please refresh to check if it was deleted.`);
            } else {
              progress.report({ increment: 70, message: "Board deletion complete!" });
              vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
            }
          }
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
      tree.refreshTree();
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
          const deletedCount = result.deleted.length;
          const errorCount = result.errors.length;
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
      
      tree.refreshTree();
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
    vscode.commands.registerCommand("mpyWorkbench.openReplFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.openRepl"); })
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
          vscode.window.setStatusBarMessage("Board: Auto sync desactivado — guardado solo en local (workspace)", 3000);
          lastLocalOnlyNotice = now;
        }
        return; // solo guardar en local
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
      try { await withAutoSuspend(() => mp.cpToDevice(doc.uri.fsPath, deviceDest)); }
  catch (e) { vscode.window.showWarningMessage(`Board auto-upload failed for ${rel}: ${String((e as any)?.message ?? e)}`); }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
  if (terminal === replTerminal || terminal.name === "Board REPL") {
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
  // Ejecutar miniterm dentro de un shell para que, al terminar/desconectarse,
  // el terminal permanezca abierto y permita ver los últimos mensajes.
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    // En Windows: usar cmd con pausa al final
    const cmd = `python -m serial.tools.miniterm ${device} 115200 & echo. & echo REPL terminado — presiona una tecla para cerrar... & pause`;
    replTerminal = vscode.window.createTerminal({
      name: "ESP32 REPL",
      shellPath: "cmd.exe",
      shellArgs: ["/d", "/c", cmd]
    });
  } else {
    // En macOS/Linux: usar bash/zsh con read al final
    const userShell = process.env.SHELL || '/bin/bash';
    const cmd = `python3 -m serial.tools.miniterm ${device} 115200; echo; echo 'REPL terminado — presiona Enter para cerrar...'; read -r`;
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
  if (strict) {
    await strictConnectHandshake(interrupt);
  } else if (interrupt) {
    try { await mp.reset(); } catch {}
  }
  const term = await getReplTerminal(context);
  term.show(true);
  // tiny delay to ensure terminal connects before next action
  await new Promise(r => setTimeout(r, 150));
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
