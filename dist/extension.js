"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// ...existing imports...
const vscode = require("vscode");
const esp32Fs_1 = require("./esp32Fs");
const actions_1 = require("./actions");
const syncView_1 = require("./syncView");
const mp = require("./mpremote");
const path = require("node:path");
const fs = require("node:fs/promises");
const node_child_process_1 = require("node:child_process");
const sync_1 = require("./sync");
const decorations_1 = require("./decorations");
const pyraw_1 = require("./pyraw");
// import { monitor } from "./monitor"; // switched to auto-suspend REPL strategy
function activate(context) {
    // Validar dependencias Python al activar la extensión
    const { execFile } = require('node:child_process');
    const pyScript = path.join(context.extensionPath, 'scripts', 'check_python_deps.py');
    execFile('python3', [pyScript], (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (out === 'ok')
            return;
        vscode.window.showWarningMessage('Dependencia faltante: pyserial. Instala pyserial en el entorno Python usado por la extensión para detectar puertos y comunicar con el dispositivo.');
    });
    // Helper to get workspace folder or throw error
    function getWorkspaceFolder() {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            throw new Error("No workspace folder open");
        return ws;
    }
    // Helper to validate if the local folder is initialized
    async function isLocalSyncInitialized() {
        try {
            const ws = getWorkspaceFolder();
            const manifestPath = path.join(ws.uri.fsPath, ".esp32sync.json");
            await fs.access(manifestPath);
            return true;
        }
        catch {
            return false;
        }
    }
    // Helper for delays in retry logic
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    // Context key for welcome UI when no port is selected
    const updatePortContext = () => {
        const v = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
        const has = !!v && v !== "auto";
        vscode.commands.executeCommand('setContext', 'mpyWorkbench.hasPort', has);
    };
    // Ensure no port is selected at startup
    vscode.workspace.getConfiguration().update("mpyWorkbench.connect", "auto", vscode.ConfigurationTarget.Global);
    updatePortContext();
    const tree = new esp32Fs_1.Esp32Tree();
    const view = vscode.window.createTreeView("mpyWorkbenchFsView", { treeDataProvider: tree });
    const actionsTree = new actions_1.ActionsTree();
    const actionsView = vscode.window.createTreeView("mpyWorkbenchActionsView", { treeDataProvider: actionsTree });
    const syncTree = new syncView_1.SyncTree();
    const syncView = vscode.window.createTreeView("mpyWorkbenchSyncView", { treeDataProvider: syncTree });
    const decorations = new decorations_1.Esp32DecorationProvider();
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
    // Export decorations for use in other modules
    global.esp32Decorations = decorations;
    // Initialize auto-sync context
    const autoSyncEnabled = vscode.workspace.getConfiguration().get("mpyWorkbench.autoSyncOnSave", true);
    vscode.commands.executeCommand('setContext', 'mpyWorkbench.autoSyncEnabled', autoSyncEnabled);
    let lastLocalOnlyNotice = 0;
    let opQueue = Promise.resolve();
    let listingInProgress = false;
    let skipIdleOnce = false;
    function setSkipIdleOnce() { skipIdleOnce = true; }
    async function ensureIdle() {
        // Keep this lightweight: do not chain kill/ctrl-c automatically.
        // Optionally perform a quick check to nudge the connection.
        try {
            await mp.ls("/");
        }
        catch { }
        if (listingInProgress) {
            const d = vscode.workspace.getConfiguration().get("mpyWorkbench.preListDelayMs", 150);
            if (d > 0)
                await new Promise(r => setTimeout(r, d));
        }
    }
    async function withAutoSuspend(fn, opts = {}) {
        const enabled = vscode.workspace.getConfiguration().get("mpyWorkbench.serialAutoSuspend", true);
        // Optionally preempt any in-flight mpremote process so new command takes priority
        if (opts.preempt !== false) {
            opQueue = Promise.resolve();
        }
        // If auto-suspend disabled or explicitly skipping for this view action, run without ensureIdle/REPL juggling
        if (!enabled || skipIdleOnce) {
            skipIdleOnce = false;
            return fn();
        }
        opQueue = opQueue.catch(() => { }).then(async () => {
            const wasOpen = isReplOpen();
            if (wasOpen)
                await closeReplTerminal();
            try {
                await ensureIdle();
                return await fn();
            }
            finally {
                if (wasOpen)
                    await openReplTerminal(context);
            }
        });
        return opQueue;
    }
    context.subscriptions.push(view, actionsView, syncView, vscode.commands.registerCommand("mpyWorkbench.refresh", () => {
        // On refresh, only issue the mpremote list without extra control signals
        tree.enableRawListForNext();
        tree.refreshTree();
    }), vscode.commands.registerCommand("mpyWorkbench.pickPort", async () => {
        // Siempre obtener la lista más reciente de puertos antes de mostrar el selector
        const ports = await mp.listSerialPorts();
        const items = [
            { label: "auto", description: "Auto-detect device" },
            ...ports.map(p => ({ label: p, description: "serial port" }))
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select Board serial port" });
        if (!picked)
            return;
        const value = picked.label === "auto" ? "auto" : picked.label;
        await vscode.workspace.getConfiguration().update("mpyWorkbench.connect", value, vscode.ConfigurationTarget.Global);
        updatePortContext();
        vscode.window.showInformationMessage(`Board connect set to ${value}`);
        tree.refreshTree();
        // Prompt for diff validation in English
        const diffPick = await vscode.window.showQuickPick([
            { label: "Check differences now", description: "Run file diff check now" },
            { label: "Don't check", description: "Continue without checking" }
        ], { placeHolder: "Check differences between local and board?" });
        if (diffPick && diffPick.label === "Check differences now") {
            try {
                await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
            }
            catch { }
        }
    }), vscode.commands.registerCommand("mpyWorkbench.serialSendCtrlC", async () => {
        const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
        if (!connect || connect === "auto") {
            vscode.window.showWarningMessage("Select a specific serial port first (not 'auto').");
            return;
        }
        // Prefer using REPL terminal if open to avoid port conflicts and return to friendly REPL
        if (isReplOpen()) {
            try {
                const term = await getReplTerminal(context);
                term.sendText("\x03", false); // Ctrl-C interrupt
                await new Promise(r => setTimeout(r, 60));
                term.sendText("\x02", false); // Ctrl-B friendly REPL
                vscode.window.showInformationMessage("Board: Interrupt sequence (Ctrl-C, Ctrl-B) sent via REPL");
                return;
            }
            catch { }
        }
        // Fallback: write directly to serial device
        const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
        const isMac = process.platform === 'darwin';
        const sttyCmd = isMac ? `stty -f ${device} 115200` : `stty -F ${device} 115200`;
        const cmd = `${sttyCmd} && printf '\\x03\\x02' > ${device}`;
        await new Promise((resolve) => {
            (0, node_child_process_1.exec)(cmd, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Board: Interrupt sequence failed: ${stderr || error.message}`);
                }
                else {
                    vscode.window.showInformationMessage(`Board: Interrupt sequence (Ctrl-C, Ctrl-B) sent to ${device}`);
                }
                resolve();
            });
        });
        // No auto-refresh here
    }), vscode.commands.registerCommand("mpyWorkbench.stop", async () => {
        const cfg = vscode.workspace.getConfiguration();
        const connect = cfg.get("mpyWorkbench.connect", "auto");
        if (!connect || connect === "auto") {
            vscode.window.showWarningMessage("Select a specific serial port first (not 'auto').");
            return;
        }
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
            }
            catch (e) {
                // fall back to writing to device below
            }
        }
        const isMac2 = process.platform === 'darwin';
        const sttyCmd2 = isMac2 ? `stty -f ${device} 115200` : `stty -F ${device} 115200`;
        const cmd2 = `${sttyCmd2} && printf '\\x03\\x01\\x04' > ${device}`;
        await new Promise((resolve) => {
            (0, node_child_process_1.exec)(cmd2, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Board: Stop sequence failed: ${stderr || error.message}`);
                }
                else {
                    vscode.window.showInformationMessage(`Board: Stop sequence sent to ${device}`);
                }
                resolve();
            });
        });
    }), vscode.commands.registerCommand("mpyWorkbench.openFileFromLocal", async (node) => {
        if (node.kind !== "file")
            return;
        try {
            const ws = getWorkspaceFolder();
            const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
            const rel = toLocalRelative(node.path, rootPath);
            const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
            await fs.access(abs);
            const doc = await vscode.workspace.openTextDocument(abs);
            await vscode.window.showTextDocument(doc, { preview: true });
        }
        catch (error) {
            vscode.window.showErrorMessage(`File not found in local workspace: ${toLocalRelative(node.path, vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/"))}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.syncFileLocalToBoard", async (node) => {
        if (node.kind !== "file")
            return;
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const rel = toLocalRelative(node.path, rootPath);
        const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
        try {
            await fs.access(abs);
        }
        catch {
            const pick = await vscode.window.showWarningMessage(`Local file not found: ${rel}. Download from board first?`, { modal: true }, "Download");
            if (pick !== "Download")
                return;
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
        }
        await withAutoSuspend(() => mp.cpToDevice(abs, node.path));
        vscode.window.showInformationMessage(`Synced local → board: ${rel}`);
    }), vscode.commands.registerCommand("mpyWorkbench.syncFileBoardToLocal", async (node) => {
        if (node.kind !== "file")
            return;
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const rel = toLocalRelative(node.path, rootPath);
        const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
        vscode.window.showInformationMessage(`Synced board → local: ${rel}`);
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
            await vscode.window.showTextDocument(doc, { preview: false });
        }
        catch { }
    }), vscode.commands.registerCommand("mpyWorkbench.setPort", async (port) => {
        await vscode.workspace.getConfiguration().update("mpyWorkbench.connect", port, vscode.ConfigurationTarget.Global);
        updatePortContext();
        vscode.window.showInformationMessage(`ESP32 connect set to ${port}`);
        tree.refreshTree();
        // Prompt for diff validation in English
        const diffPick = await vscode.window.showQuickPick([
            { label: "Check differences now", description: "Run file diff check now" },
            { label: "Don't check", description: "Continue without checking" }
        ], { placeHolder: "Check differences between local and board?" });
        if (diffPick && diffPick.label === "Check differences now") {
            try {
                await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
            }
            catch { }
        }
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaseline", async () => {
        try {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) {
                vscode.window.showErrorMessage("No workspace folder open");
                return;
            }
            const initialized = await isLocalSyncInitialized();
            if (!initialized) {
                const initialize = await vscode.window.showWarningMessage("The local folder is not initialized for synchronization. Would you like to initialize it now?", { modal: true }, "Initialize");
                if (initialize !== "Initialize")
                    return;
                // Create initial manifest to initialize sync
                const ignore = (0, sync_1.defaultIgnore)();
                const initialManifest = await (0, sync_1.buildManifest)(ws.uri.fsPath, ignore);
                const manifestPath = path.join(ws.uri.fsPath, ".esp32sync.json");
                await (0, sync_1.saveManifest)(manifestPath, initialManifest);
                vscode.window.showInformationMessage("Local folder initialized for synchronization.");
            }
            const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
            const ignore = (0, sync_1.defaultIgnore)();
            const man = await (0, sync_1.buildManifest)(ws.uri.fsPath, ignore);
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
                            }
                            catch {
                                // Directory might already exist, ignore error
                            }
                        }
                        await mp.uploadReplacing(localPath, devicePath);
                    }
                });
            });
            // Save manifest locally and on device
            const manifestPath = path.join(ws.uri.fsPath, ".esp32sync.json");
            await (0, sync_1.saveManifest)(manifestPath, man);
            const tmp = path.join(context.globalStorageUri.fsPath, "esp32sync.json");
            await fs.mkdir(path.dirname(tmp), { recursive: true });
            await fs.writeFile(tmp, JSON.stringify(man));
            const deviceManifest = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/.esp32sync.json";
            await withAutoSuspend(() => mp.cpToDevice(tmp, deviceManifest));
            vscode.window.showInformationMessage("Board: Sync all files (Local → Board) completed");
            tree.refreshTree();
        }
        catch (error) {
            vscode.window.showErrorMessage(`Upload failed: ${error?.message ?? String(error)}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoard", async () => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync all files (Board → Local)", cancellable: false }, async (progress) => {
            let done = 0;
            const total = deviceStats.length;
            await withAutoSuspend(async () => {
                for (const stat of deviceStats) {
                    if (stat.isDir)
                        continue;
                    const rel = toLocalRelative(stat.path, rootPath);
                    const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
                    progress.report({ message: `Downloading ${rel} (${++done}/${total})` });
                    await fs.mkdir(path.dirname(abs), { recursive: true });
                    await mp.cpFromDevice(stat.path, abs);
                }
            });
        });
        vscode.window.showInformationMessage("Board: Sync all files (Board → Local) completed");
    }), vscode.commands.registerCommand("mpyWorkbench.openSerial", async () => {
        await openReplTerminal(context);
    }), vscode.commands.registerCommand("mpyWorkbench.openRepl", async () => {
        const term = await getReplTerminal(context);
        term.show(true);
    }), vscode.commands.registerCommand("mpyWorkbench.stopSerial", async () => {
        await closeReplTerminal();
        vscode.window.showInformationMessage("Board: REPL closed");
    }), vscode.commands.registerCommand("mpyWorkbench.autoSuspendLs", async (pathArg) => {
        listingInProgress = true;
        try {
            const usePyRaw = vscode.workspace.getConfiguration().get("mpyWorkbench.usePyRawList", false);
            return await withAutoSuspend(() => (usePyRaw ? (0, pyraw_1.listDirPyRaw)(pathArg) : mp.lsTyped(pathArg)), { preempt: false });
        }
        finally {
            listingInProgress = false;
        }
    }), 
    // Keep welcome button visibility in sync if user changes settings directly
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('mpyWorkbench.connect'))
            updatePortContext();
    }), vscode.commands.registerCommand("mpyWorkbench.uploadActiveFile", async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
            vscode.window.showErrorMessage("No active editor");
            return;
        }
        await ed.document.save();
        const ws = vscode.workspace.getWorkspaceFolder(ed.document.uri);
        const rel = ws ? path.relative(ws.uri.fsPath, ed.document.uri.fsPath) : path.basename(ed.document.uri.fsPath);
        const dest = "/" + rel.replace(/\\\\/g, "/");
        // Use replacing upload to avoid partial writes while code may autostart
        await withAutoSuspend(() => mp.uploadReplacing(ed.document.uri.fsPath, dest));
        vscode.window.showInformationMessage(`Uploaded to ${dest}`);
    }), vscode.commands.registerCommand("mpyWorkbench.runActiveFile", async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
            vscode.window.showErrorMessage("No active editor");
            return;
        }
        await ed.document.save();
        // Open/show the REPL terminal and execute the file in RAW REPL mode to not show the pasted code
        const term = await getReplTerminal(context);
        term.show(true);
        // Pequeña pausa para asegurar conexión de la terminal
        await new Promise(r => setTimeout(r, 150));
        // Interrumpir y entrar en RAW REPL (no eco de entrada)
        term.sendText("\x03", false); // Ctrl-C
        await new Promise(r => setTimeout(r, 60));
        term.sendText("\x01", false); // Ctrl-A (raw REPL)
        await new Promise(r => setTimeout(r, 100));
        // Send the complete file content; in RAW REPL the text is not shown
        const text = ed.document.getText().replace(/\r\n/g, "\n");
        term.sendText(text, true);
        // Finalizar y ejecutar
        term.sendText("\x04", false); // Ctrl-D (ejecutar en raw)
        // Volver al REPL amigable tras un pequeño intervalo
        await new Promise(r => setTimeout(r, 150));
        term.sendText("\x02", false); // Ctrl-B (friendly REPL)
    }), vscode.commands.registerCommand("mpyWorkbench.checkDiffs", async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Checking file differences...",
            cancellable: false
        }, async (progress) => {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) {
                vscode.window.showErrorMessage("No workspace folder open");
                return;
            }
            // Check if workspace is initialized for sync
            const initialized = await isLocalSyncInitialized();
            if (!initialized) {
                const initialize = await vscode.window.showWarningMessage("The local folder is not initialized for synchronization. Would you like to initialize it now?", { modal: true }, "Initialize");
                if (initialize !== "Initialize")
                    return;
                // Create initial manifest to initialize sync
                const ignore = (0, sync_1.defaultIgnore)();
                const initialManifest = await (0, sync_1.buildManifest)(ws.uri.fsPath, ignore);
                const manifestPath = path.join(ws.uri.fsPath, ".esp32sync.json");
                await (0, sync_1.saveManifest)(manifestPath, initialManifest);
                vscode.window.showInformationMessage("Local folder initialized for synchronization.");
            }
            const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
            progress.report({ message: "Reading board files..." });
            const relFromDevice = (devicePath) => {
                const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
                if (normRoot === "/")
                    return devicePath.replace(/^\//, "");
                if (devicePath.startsWith(normRoot + "/"))
                    return devicePath.slice(normRoot.length + 1);
                if (devicePath === normRoot)
                    return "";
                return devicePath.replace(/^\//, "");
            };
            const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
            const deviceFiles = deviceStats.filter(e => !e.isDir);
            const diffSet = new Set();
            progress.report({ message: "Comparing files..." });
            for (const f of deviceFiles) {
                const rel = relFromDevice(f.path);
                const abs = path.join(ws.uri.fsPath, ...rel.split('/'));
                try {
                    const st = await fs.stat(abs);
                    const same = st.size === f.size; // mtime across fs may be unreliable; size is a good first pass
                    if (!same)
                        diffSet.add(f.path);
                }
                catch { // missing locally
                    diffSet.add(f.path);
                }
            }
            progress.report({ message: "Checking local files..." });
            // Check for files that exist locally but not on board
            const localOnlySet = new Set();
            const toDevicePath = (localRel) => {
                const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
                if (normRoot === "/")
                    return "/" + localRel;
                return localRel === "" ? normRoot : normRoot + "/" + localRel;
            };
            // Get all local files using the existing manifest/ignore system
            const ignore = (0, sync_1.defaultIgnore)();
            const localManifest = await (0, sync_1.buildManifest)(ws.uri.fsPath, ignore);
            const deviceFileSet = new Set(deviceFiles.map(f => f.path));
            for (const localRel of Object.keys(localManifest.files)) {
                const devicePath = toDevicePath(localRel);
                if (!deviceFileSet.has(devicePath)) {
                    localOnlySet.add(devicePath);
                }
            }
            progress.report({ message: "Processing differences..." });
            // Mark parent dirs for any differing children
            const parents = new Set();
            for (const p of diffSet) {
                let cur = p;
                while (cur.includes('/')) {
                    cur = cur.substring(0, cur.lastIndexOf('/')) || '/';
                    parents.add(cur);
                    if (cur === '/' || cur === rootPath)
                        break;
                }
            }
            for (const d of parents)
                diffSet.add(d);
            // Mark parent dirs for local-only files too
            for (const p of localOnlySet) {
                let cur = p;
                while (cur.includes('/')) {
                    cur = cur.substring(0, cur.lastIndexOf('/')) || '/';
                    parents.add(cur);
                    if (cur === '/' || cur === rootPath)
                        break;
                }
            }
            for (const d of parents)
                localOnlySet.add(d);
            decorations.setDiffs(diffSet);
            decorations.setLocalOnly(localOnlySet);
            const totalFlagged = diffSet.size + localOnlySet.size;
            vscode.window.showInformationMessage(`Board: Diff check complete (${diffSet.size} changed, ${localOnlySet.size} local-only, ${totalFlagged} total flagged)`);
        });
    }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsLocalToBoard", async () => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const initialized = await isLocalSyncInitialized();
        if (!initialized) {
            const initialize = await vscode.window.showWarningMessage("The local folder is not initialized for synchronization. Would you like to initialize it now?", { modal: true }, "Initialize");
            if (initialize !== "Initialize")
                return;
            // Create initial manifest to initialize sync
            const ignore = (0, sync_1.defaultIgnore)();
            const initialManifest = await (0, sync_1.buildManifest)(ws.uri.fsPath, ignore);
            const manifestPath = path.join(ws.uri.fsPath, ".esp32sync.json");
            await (0, sync_1.saveManifest)(manifestPath, initialManifest);
            vscode.window.showInformationMessage("Local folder initialized for synchronization.");
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        // Get current diffs and filter to files by comparing with current device stats
        // Check if differences have been detected first
        const allDiffs = decorations.getDiffs();
        if (allDiffs.length === 0) {
            const runCheck = await vscode.window.showInformationMessage("No file differences detected. You need to check for differences first before syncing.", "Check Differences Now");
            if (runCheck === "Check Differences Now") {
                await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
                // After checking diffs, try again
                const newDiffs = decorations.getDiffs();
                if (newDiffs.length === 0) {
                    vscode.window.showInformationMessage("No differences found between local and board files.");
                    return;
                }
            }
            else {
                return;
            }
        }
        const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        const filesSet = new Set(deviceStats.filter(e => !e.isDir).map(e => e.path));
        const diffs = decorations.getDiffs().filter(p => filesSet.has(p));
        const localOnlyFiles = decorations.getLocalOnly();
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
                    }
                    catch {
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
    }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsBoardToLocal", async () => {
        const ws2 = vscode.workspace.workspaceFolders?.[0];
        if (!ws2) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const initialized = await isLocalSyncInitialized();
        if (!initialized) {
            const initialize = await vscode.window.showWarningMessage("The local folder is not initialized for synchronization. Would you like to initialize it now?", { modal: true }, "Initialize");
            if (initialize !== "Initialize")
                return;
            // Create initial manifest to initialize sync
            const ignore = (0, sync_1.defaultIgnore)();
            const initialManifest = await (0, sync_1.buildManifest)(ws2.uri.fsPath, ignore);
            const manifestPath = path.join(ws2.uri.fsPath, ".esp32sync.json");
            await (0, sync_1.saveManifest)(manifestPath, initialManifest);
            vscode.window.showInformationMessage("Local folder initialized for synchronization.");
        }
        const rootPath2 = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        // Get current diffs and filter to files by comparing with current device stats
        const deviceStats2 = await withAutoSuspend(() => mp.listTreeStats(rootPath2));
        const filesSet2 = new Set(deviceStats2.filter(e => !e.isDir).map(e => e.path));
        const diffs2 = decorations.getDiffs().filter(p => filesSet2.has(p));
        if (diffs2.length === 0) {
            const checkNow = await vscode.window.showWarningMessage("Board: No diffed files found to sync. You need to run 'Check Differences' first to detect changes between board and local files.", { modal: true }, "Check Differences Now");
            if (checkNow === "Check Differences Now") {
                await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
            }
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync Diffed Files Board → Local", cancellable: false }, async (progress) => {
            let done = 0;
            const total = diffs2.length;
            await withAutoSuspend(async () => {
                for (const devicePath of diffs2) {
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
    }), vscode.commands.registerCommand("mpyWorkbench.openFile", async (node) => {
        if (node.kind !== "file")
            return;
        const ws = vscode.workspace.workspaceFolders?.[0];
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        if (ws) {
            const rel = toLocalRelative(node.path, rootPath);
            const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
            await fs.mkdir(path.dirname(abs), { recursive: true });
            // If not present locally, fetch from device to local path
            try {
                await fs.access(abs);
            }
            catch {
                await withAutoSuspend(() => mp.cpFromDevice(node.path, abs));
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
            await vscode.window.showTextDocument(doc, { preview: false });
            await context.workspaceState.update("mpyWorkbench.lastOpenedPath", abs);
        }
        else {
            // Fallback: no workspace, use temp
            const temp = vscode.Uri.joinPath(context.globalStorageUri, node.path.replace(/\//g, "_"));
            await fs.mkdir(path.dirname(temp.fsPath), { recursive: true });
            await withAutoSuspend(() => mp.cpFromDevice(node.path, temp.fsPath));
            const doc = await vscode.workspace.openTextDocument(temp);
            await vscode.window.showTextDocument(doc, { preview: true });
            await context.workspaceState.update("mpyWorkbench.lastOpenedPath", temp.fsPath);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.mkdir", async (node) => {
        const base = node?.kind === "dir" ? node.path : (node ? path.posix.dirname(node.path) : "/");
        const name = await vscode.window.showInputBox({ prompt: "New folder name", validateInput: v => v ? undefined : "Required" });
        if (!name)
            return;
        const target = base === "/" ? `/${name}` : `${base}/${name}`;
        await withAutoSuspend(() => mp.mkdir(target));
        tree.refreshTree();
    }), vscode.commands.registerCommand("mpyWorkbench.delete", async (node) => {
        const okBoard = await vscode.window.showWarningMessage(`Delete ${node.path} from board?`, { modal: true }, "Delete");
        if (okBoard !== "Delete")
            return;
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
                }
                else {
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
                    }
                    catch (error) {
                        // If there's an error verifying, assume it was deleted
                        existsAfter = false;
                        break;
                    }
                }
                if (existsAfter) {
                    progress.report({ increment: 100, message: "Deletion verification failed!" });
                    vscode.window.showWarningMessage(`${node.path} was processed but verification failed. Please refresh to check if it was deleted.`);
                }
                else {
                    progress.report({ increment: 100, message: "Deletion complete!" });
                    vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
                }
            }
            catch (err) {
                progress.report({ increment: 100, message: "Deletion failed!" });
                vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
            }
        });
        tree.refreshTree();
    }), vscode.commands.registerCommand("mpyWorkbench.deleteBoardAndLocal", async (node) => {
        const okBoardLocal = await vscode.window.showWarningMessage(`Delete ${node.path} from board AND local workspace?`, { modal: true }, "Delete");
        if (okBoardLocal !== "Delete")
            return;
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
                }
                else {
                    progress.report({ increment: 30, message: "Connecting to board..." });
                    if (fileInfo.isDir) {
                        progress.report({ increment: 50, message: "Removing directory from board..." });
                        await withAutoSuspend(() => mp.deleteFolderRecursive(node.path));
                    }
                    else {
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
                        }
                        catch (error) {
                            // If there's an error verifying, assume it was deleted
                            existsAfter = false;
                            break;
                        }
                    }
                    if (existsAfter) {
                        progress.report({ increment: 60, message: "Board deletion verification failed!" });
                        vscode.window.showWarningMessage(`${node.path} was processed but verification failed. Please refresh to check if it was deleted.`);
                    }
                    else {
                        progress.report({ increment: 70, message: "Board deletion complete!" });
                        vscode.window.showInformationMessage(`Successfully deleted ${node.path} from board`);
                    }
                }
            }
            catch (err) {
                progress.report({ increment: 70, message: "Board deletion failed!" });
                vscode.window.showErrorMessage(`Failed to delete ${node.path} from board: ${err?.message ?? String(err)}`);
            }
        });
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
            const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
            const rel = toLocalRelative(node.path, rootPath);
            const abs = path.join(ws.uri.fsPath, ...rel.split("/"));
            try {
                await fs.rm(abs, { recursive: true, force: true });
            }
            catch { }
        }
        tree.refreshTree();
    }), vscode.commands.registerCommand("mpyWorkbench.deleteAllBoard", async () => {
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const warn = await vscode.window.showWarningMessage(`This will DELETE ALL files and folders under '${rootPath}' on the board. This cannot be undone.`, { modal: true }, "Delete All");
        if (warn !== "Delete All")
            return;
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
                    vscode.window.showWarningMessage(`Board: Deleted ${deletedCount} items, but ${errorCount} failed. ${remainingCount} items remain. Check console for details.`);
                }
                else if (remainingCount > 0) {
                    vscode.window.showWarningMessage(`Board: Deleted ${deletedCount} items, but ${remainingCount} system files remain (this is normal).`);
                }
                else {
                    vscode.window.showInformationMessage(`Board: Successfully deleted all ${deletedCount} files and folders under ${rootPath}`);
                }
            }
            catch (error) {
                progress.report({ increment: 100, message: "Deletion failed!" });
                vscode.window.showErrorMessage(`Failed to delete files from board: ${error?.message ?? String(error)}`);
            }
        });
        tree.refreshTree();
    }), vscode.commands.registerCommand("mpyWorkbench.deleteAllBoardFromView", async () => {
        await vscode.commands.executeCommand("mpyWorkbench.deleteAllBoard");
    }), 
    // View wrappers: run commands without pre-ops (no kill/Ctrl-C)
    vscode.commands.registerCommand("mpyWorkbench.runFromView", async (cmd, ...args) => {
        setSkipIdleOnce();
        try {
            await vscode.commands.executeCommand(cmd, ...args);
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            vscode.window.showErrorMessage(`Board command failed: ${msg}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaseline"); }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoardFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaselineFromBoard"); }), vscode.commands.registerCommand("mpyWorkbench.checkDiffsFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.checkDiffs"); }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsLocalToBoardFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncDiffsLocalToBoard"); }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsBoardToLocalFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncDiffsBoardToLocal"); }), vscode.commands.registerCommand("mpyWorkbench.runActiveFileFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.runActiveFile"); }), vscode.commands.registerCommand("mpyWorkbench.openReplFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.openRepl"); }), vscode.commands.registerCommand("mpyWorkbench.toggleAutoSync", async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update("mpyWorkbench.autoSyncOnSave", false, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage("Auto sync disabled - files will only save locally");
        await vscode.commands.executeCommand('setContext', 'mpyWorkbench.autoSyncEnabled', false);
    }), vscode.commands.registerCommand("mpyWorkbench.toggleAutoSyncOff", async () => {
        const config = vscode.workspace.getConfiguration();
        await config.update("mpyWorkbench.autoSyncOnSave", true, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage("Auto sync enabled - files will sync automatically on save");
        await vscode.commands.executeCommand('setContext', 'mpyWorkbench.autoSyncEnabled', true);
    }));
    // Auto-upload on save: if file is inside a workspace, push to device path mapped by mpyWorkbench.rootPath
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!ws)
            return;
        const autoSync = vscode.workspace.getConfiguration().get("mpyWorkbench.autoSyncOnSave", true);
        if (!autoSync) {
            const now = Date.now();
            if (now - lastLocalOnlyNotice > 5000) {
                vscode.window.setStatusBarMessage("Board: Auto sync desactivado — guardado solo en local", 3000);
                lastLocalOnlyNotice = now;
            }
            return; // solo guardar en local
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const rel = path.relative(ws.uri.fsPath, doc.uri.fsPath).replace(/\\/g, "/");
        const deviceDest = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/" + rel;
        try {
            await withAutoSuspend(() => mp.cpToDevice(doc.uri.fsPath, deviceDest));
        }
        catch (e) {
            vscode.window.showWarningMessage(`Board auto-upload failed for ${rel}: ${String(e?.message ?? e)}`);
        }
    }), vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === replTerminal || terminal.name === "Board REPL") {
            replTerminal = undefined;
        }
    }), vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mpyWorkbench.autoSyncOnSave')) {
            const autoSyncEnabled = vscode.workspace.getConfiguration().get("mpyWorkbench.autoSyncOnSave", true);
            vscode.commands.executeCommand('setContext', 'mpyWorkbench.autoSyncEnabled', autoSyncEnabled);
        }
    }));
}
function deactivate() { }
let replTerminal;
async function getReplTerminal(context) {
    if (replTerminal) {
        const alive = vscode.window.terminals.some(t => t === replTerminal);
        if (alive)
            return replTerminal;
        replTerminal = undefined;
    }
    const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
    // Usar miniterm directamente para mantener interactividad completa
    replTerminal = vscode.window.createTerminal({
        name: "ESP32 REPL",
        shellPath: "python3",
        shellArgs: ["-m", "serial.tools.miniterm", device, "115200"]
    });
    return replTerminal;
}
function isReplOpen() {
    if (!replTerminal)
        return false;
    return vscode.window.terminals.some(t => t === replTerminal);
}
async function closeReplTerminal() {
    if (replTerminal) {
        try {
            replTerminal.dispose();
        }
        catch { }
        replTerminal = undefined;
        await new Promise(r => setTimeout(r, 300));
    }
}
async function openReplTerminal(context) {
    // Strict handshake like Thonny: ensure device is interrupted and responsive before opening REPL
    const cfg = vscode.workspace.getConfiguration();
    const interrupt = cfg.get("mpyWorkbench.interruptOnConnect", true);
    const strict = cfg.get("mpyWorkbench.strictConnect", true);
    if (strict) {
        await strictConnectHandshake(interrupt);
    }
    else if (interrupt) {
        try {
            await mp.reset();
        }
        catch { }
    }
    const term = await getReplTerminal(context);
    term.show(true);
    // tiny delay to ensure terminal connects before next action
    await new Promise(r => setTimeout(r, 150));
}
async function strictConnectHandshake(interrupt) {
    // Try reset + quick op, retry once if needed
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            if (interrupt)
                await mp.reset();
            // quick check: ls root; if it returns without throwing, we assume we're good
            await mp.ls("/");
            return;
        }
        catch (e) {
            if (attempt === 2)
                break;
            // small backoff then retry
            await new Promise(r => setTimeout(r, 200));
        }
    }
}
function toLocalRelative(devicePath, rootPath) {
    const normRoot = rootPath === "/" ? "/" : rootPath.replace(/\/$/, "");
    if (normRoot === "/")
        return devicePath.replace(/^\//, "");
    if (devicePath.startsWith(normRoot + "/"))
        return devicePath.slice(normRoot.length + 1);
    if (devicePath === normRoot)
        return "";
    // Fallback: strip leading slash
    return devicePath.replace(/^\//, "");
}
// (no stray command registrations beyond this point)
//# sourceMappingURL=extension.js.map