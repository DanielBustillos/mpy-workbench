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
    // Helper para validar si la carpeta local está inicializada
    async function isLocalSyncInitialized() {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            return false;
        const manifestPath = path.join(ws.uri.fsPath, ".esp32sync.json");
        try {
            await fs.access(manifestPath);
            return true;
        }
        catch {
            return false;
        }
    }
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
                    await openReplTerminal();
            }
        });
        return opQueue;
    }
    context.subscriptions.push(view, actionsView, syncView, vscode.commands.registerCommand("mpyWorkbench.refresh", () => {
        // On refresh, only issue the mpremote list without extra control signals
        tree.setRawListOnlyOnce();
        tree.refresh();
    }), vscode.commands.registerCommand("mpyWorkbench.pickPort", async () => {
        const ports = await mp.listSerialPorts();
        const items = [
            { label: "auto", description: "Auto-detect device" },
            ...ports.map(p => ({ label: p, description: "serial port" }))
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select ESP32 serial port" });
        if (!picked)
            return;
        const value = picked.label === "auto" ? "auto" : picked.label;
        await vscode.workspace.getConfiguration().update("mpyWorkbench.connect", value, vscode.ConfigurationTarget.Global);
        updatePortContext();
        vscode.window.showInformationMessage(`ESP32 connect set to ${value}`);
        tree.refresh();
        // After selecting port, check diffs so user sees up-to-date status
        try {
            await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
        }
        catch { }
    }), vscode.commands.registerCommand("mpyWorkbench.serialSendCtrlC", async () => {
        const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
        if (!connect || connect === "auto") {
            vscode.window.showWarningMessage("Select a specific serial port first (not 'auto').");
            return;
        }
        // Prefer using REPL terminal if open to avoid port conflicts and return to friendly REPL
        if (isReplOpen()) {
            try {
                const term = await getReplTerminal();
                term.sendText("\x03", false); // Ctrl-C interrupt
                await new Promise(r => setTimeout(r, 60));
                term.sendText("\x02", false); // Ctrl-B friendly REPL
                vscode.window.showInformationMessage("ESP32: Interrupt sequence (Ctrl-C, Ctrl-B) sent via REPL");
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
                    vscode.window.showErrorMessage(`ESP32: Interrupt sequence failed: ${stderr || error.message}`);
                }
                else {
                    vscode.window.showInformationMessage(`ESP32: Interrupt sequence (Ctrl-C, Ctrl-B) sent to ${device}`);
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
                const term = await getReplTerminal();
                term.sendText("\x03", false); // Ctrl-C
                await new Promise(r => setTimeout(r, 60));
                term.sendText("\x01", false); // Ctrl-A (raw repl)
                await new Promise(r => setTimeout(r, 60));
                term.sendText("\x04", false); // Ctrl-D (soft reboot)
                vscode.window.showInformationMessage("ESP32: Stop sequence sent via REPL");
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
                    vscode.window.showErrorMessage(`ESP32: Stop sequence failed: ${stderr || error.message}`);
                }
                else {
                    vscode.window.showInformationMessage(`ESP32: Stop sequence sent to ${device}`);
                }
                resolve();
            });
        });
    }), vscode.commands.registerCommand("mpyWorkbench.killPortUsers", async () => {
        const cfg = vscode.workspace.getConfiguration();
        const connect = cfg.get("mpyWorkbench.connect", "auto");
        if (!connect || connect === "auto") {
            vscode.window.showWarningMessage("Select a specific serial port first (not 'auto').");
            return;
        }
        const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
        // Close our REPL if open to avoid killing our own holder
        await closeReplTerminal();
        const lsofCmd = `lsof -nP ${device}`;
        const execp = (cmd) => new Promise(res => (0, node_child_process_1.exec)(cmd, (error, stdout, stderr) => res({ stdout: String(stdout), stderr: String(stderr), error: (error || undefined) })));
        const { stdout } = await execp(lsofCmd);
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length <= 1) {
            vscode.window.showInformationMessage(`No processes using ${device}`);
            return;
        }
        const pids = new Set();
        for (const line of lines.slice(1)) {
            const cols = line.trim().split(/\s+/);
            const pid = Number(cols[1]);
            if (!Number.isNaN(pid) && pid !== process.pid)
                pids.add(pid);
        }
        if (pids.size === 0) {
            vscode.window.showInformationMessage(`No processes to close for ${device}`);
            return;
        }
        // Try to kill gracefully, then force
        for (const pid of pids) {
            try {
                process.kill(pid, 'SIGTERM');
            }
            catch { }
        }
        await new Promise(r => setTimeout(r, 300));
        // Check again; force kill remaining
        const { stdout: stdout2 } = await execp(lsofCmd);
        const still = new Set();
        stdout2.split(/\r?\n/).slice(1).forEach(line => {
            const cols = line.trim().split(/\s+/);
            const pid = Number(cols[1]);
            if (!Number.isNaN(pid) && pid !== process.pid)
                still.add(pid);
        });
        for (const pid of still) {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch { }
        }
        if (still.size > 0) {
            // If some remain (likely need sudo), open a terminal prefilled with a sudo command
            const term = vscode.window.createTerminal({ name: 'Close other port services' });
            term.show(true);
            const list = Array.from(still).join(' ');
            term.sendText(`sudo lsof -nP ${device} && sudo kill -9 ${list}`);
            vscode.window.showWarningMessage(`Some processes may require sudo to close. A terminal was opened with the command.`);
        }
        else {
            vscode.window.showInformationMessage(`Closed processes using ${device}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.openFileFromBoard", async (node) => {
        if (node.kind !== "file")
            return;
        const temp = vscode.Uri.joinPath(context.globalStorageUri, "from-board", node.path.replace(/\//g, "_"));
        await fs.mkdir(path.dirname(temp.fsPath), { recursive: true });
        await withAutoSuspend(() => mp.cpFromDevice(node.path, temp.fsPath));
        const doc = await vscode.workspace.openTextDocument(temp);
        await vscode.window.showTextDocument(doc, { preview: true });
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
        tree.refresh();
        // After selecting port, run diff check
        try {
            await vscode.commands.executeCommand("mpyWorkbench.checkDiffs");
        }
        catch { }
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaseline", async () => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const initialized = await isLocalSyncInitialized();
        if (!initialized) {
            vscode.window.showWarningMessage("La carpeta local no está inicializada para sincronización. Inicialízala antes de sincronizar.");
            return;
        }
        try {
            await vscode.commands.executeCommand("mpyWorkbench.syncWorkspaceToDevice");
        }
        catch { }
        const ignore = (0, sync_1.defaultIgnore)();
        const man = await (0, sync_1.buildManifest)(ws.uri.fsPath, ignore);
        const manifestPath = path.join(ws.uri.fsPath, ".esp32sync.json");
        await (0, sync_1.saveManifest)(manifestPath, man);
        const tmp = path.join(context.globalStorageUri.fsPath, "esp32sync.json");
        await fs.mkdir(path.dirname(tmp), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(man));
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const deviceManifest = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/.esp32sync.json";
        await withAutoSuspend(() => mp.cpToDevice(tmp, deviceManifest));
        vscode.window.showInformationMessage("ESP32: Sync all files (Local → Board) completed");
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoard", async () => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "ESP32: Sync all files (Board → Local)", cancellable: false }, async (progress) => {
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
        vscode.window.showInformationMessage("ESP32: Sync all files (Board → Local) completed");
    }), vscode.commands.registerCommand("mpyWorkbench.openSerial", async () => {
        await openReplTerminal();
    }), vscode.commands.registerCommand("mpyWorkbench.openRepl", async () => {
        const term = await getReplTerminal();
        term.show(true);
    }), vscode.commands.registerCommand("mpyWorkbench.stopSerial", async () => {
        await closeReplTerminal();
        vscode.window.showInformationMessage("ESP32: REPL closed");
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
    }), 
    // Removed control commands (Stop/Interrupt/Soft Reboot)
    // Removed old sync commands (sync current folder / full workspace)
    vscode.commands.registerCommand("mpyWorkbench.uploadActiveFile", async () => {
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
        // Abrir/mostrar la terminal REPL y ejecutar el archivo en modo RAW REPL para no mostrar el código pegado
        const term = await getReplTerminal();
        term.show(true);
        // Pequeña pausa para asegurar conexión de la terminal
        await new Promise(r => setTimeout(r, 150));
        // Interrumpir y entrar en RAW REPL (no eco de entrada)
        term.sendText("\x03", false); // Ctrl-C
        await new Promise(r => setTimeout(r, 60));
        term.sendText("\x01", false); // Ctrl-A (raw REPL)
        await new Promise(r => setTimeout(r, 100));
        // Enviar el contenido del archivo completo; en RAW REPL no se muestra el texto
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
            decorations.setDiffs(diffSet);
            vscode.window.showInformationMessage(`ESP32: Diff check complete (${diffSet.size} items flagged)`);
        });
    }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsLocalToBoard", async () => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const initialized = await isLocalSyncInitialized();
        if (!initialized) {
            vscode.window.showWarningMessage("La carpeta local no está inicializada para sincronización. Inicialízala antes de sincronizar.");
            return;
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        // Get current diffs and filter to files by comparing with current device stats
        const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        const filesSet = new Set(deviceStats.filter(e => !e.isDir).map(e => e.path));
        const diffs = decorations.getDiffs().filter(p => filesSet.has(p));
        if (diffs.length === 0) {
            vscode.window.showInformationMessage("ESP32: No diffed files to sync");
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "ESP32: Sync Diffed Files Local → Board", cancellable: false }, async (progress) => {
            let done = 0;
            const total = diffs.length;
            await withAutoSuspend(async () => {
                for (const devicePath of diffs) {
                    const rel = toLocalRelative(devicePath, rootPath);
                    const abs = path.join(ws.uri.fsPath, ...rel.split('/'));
                    try {
                        await fs.access(abs);
                    }
                    catch {
                        continue;
                    }
                    progress.report({ message: `Uploading ${rel} (${++done}/${total})` });
                    await mp.uploadReplacing(abs, devicePath);
                }
            });
        });
        decorations.clear();
        vscode.window.showInformationMessage("ESP32: Diffed files uploaded to board and marks cleared");
        tree.refresh();
    }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsBoardToLocal", async () => {
        const ws2 = vscode.workspace.workspaceFolders?.[0];
        if (!ws2) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const rootPath2 = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        // Get current diffs and filter to files by comparing with current device stats
        const deviceStats2 = await withAutoSuspend(() => mp.listTreeStats(rootPath2));
        const filesSet2 = new Set(deviceStats2.filter(e => !e.isDir).map(e => e.path));
        const diffs2 = decorations.getDiffs().filter(p => filesSet2.has(p));
        if (diffs2.length === 0) {
            vscode.window.showInformationMessage("ESP32: No diffed files to sync");
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "ESP32: Sync Diffed Files Board → Local", cancellable: false }, async (progress) => {
            let done = 0;
            const total = diffs2.length;
            await withAutoSuspend(async () => {
                for (const devicePath of diffs2) {
                    const rel = toLocalRelative(devicePath, rootPath2);
                    const abs = path.join(ws2.uri.fsPath, ...rel.split('/'));
                    progress.report({ message: `Descargando ${rel} (${++done}/${total})` });
                    await fs.mkdir(path.dirname(abs), { recursive: true });
                    await mp.cpFromDevice(devicePath, abs);
                }
            });
        });
        decorations.clear();
        vscode.window.showInformationMessage("ESP32: Diffed files downloaded from board and marks cleared");
        tree.refresh();
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
        tree.refresh();
    }), vscode.commands.registerCommand("mpyWorkbench.delete", async (node) => {
        const okBoard = await vscode.window.showWarningMessage(`Delete ${node.path} from board?`, { modal: true }, "Delete");
        if (okBoard !== "Delete")
            return;
        await withAutoSuspend(() => mp.rm(node.path));
        tree.refresh();
    }), vscode.commands.registerCommand("mpyWorkbench.deleteBoardAndLocal", async (node) => {
        const okBoardLocal = await vscode.window.showWarningMessage(`Delete ${node.path} from board AND local workspace?`, { modal: true }, "Delete");
        if (okBoardLocal !== "Delete")
            return;
        await withAutoSuspend(() => mp.rm(node.path));
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
        tree.refresh();
        const ok = await vscode.window.showWarningMessage(`Delete ${node.path}?`, { modal: true }, "Delete");
        if (ok !== "Delete")
            return;
        await withAutoSuspend(() => mp.rm(node.path));
        tree.refresh();
    }), 
    // View wrappers: run commands without pre-ops (no kill/Ctrl-C)
    vscode.commands.registerCommand("mpyWorkbench.runFromView", async (cmd, ...args) => {
        setSkipIdleOnce();
        try {
            await vscode.commands.executeCommand(cmd, ...args);
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            vscode.window.showErrorMessage(`ESP32 command failed: ${msg}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaseline"); }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoardFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaselineFromBoard"); }), vscode.commands.registerCommand("mpyWorkbench.checkDiffsFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.checkDiffs"); }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsLocalToBoardFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncDiffsLocalToBoard"); }), vscode.commands.registerCommand("mpyWorkbench.syncDiffsBoardToLocalFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncDiffsBoardToLocal"); }), vscode.commands.registerCommand("mpyWorkbench.runActiveFileFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.runActiveFile"); }), vscode.commands.registerCommand("mpyWorkbench.openReplFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.openRepl"); }));
    // Auto-upload on save: if file is inside a workspace, push to device path mapped by mpyWorkbench.rootPath
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!ws)
            return;
        const autoSync = vscode.workspace.getConfiguration().get("mpyWorkbench.autoSyncOnSave", true);
        if (!autoSync) {
            const now = Date.now();
            if (now - lastLocalOnlyNotice > 5000) {
                vscode.window.setStatusBarMessage("ESP32: Auto sync desactivado — guardado solo en local", 3000);
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
            vscode.window.showWarningMessage(`ESP32 auto-upload failed for ${rel}: ${String(e?.message ?? e)}`);
        }
    }), vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === replTerminal || terminal.name === "ESP32 REPL") {
            replTerminal = undefined;
        }
    }));
}
function deactivate() { }
let replTerminal;
async function getReplTerminal() {
    if (replTerminal) {
        const alive = vscode.window.terminals.some(t => t === replTerminal);
        if (alive)
            return replTerminal;
        replTerminal = undefined;
    }
    const connect = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
    // Launch terminal using Python's miniterm (pyserial)
    const device = connect.replace(/^serial:\/\//, "").replace(/^serial:\//, "");
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
async function openReplTerminal() {
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
    const term = await getReplTerminal();
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