"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const esp32Fs_1 = require("./esp32Fs");
const actions_1 = require("./actions");
const syncView_1 = require("./syncView");
const localFilesView_1 = require("./localFilesView");
const mp = require("./mpremote");
const mpremote_1 = require("./mpremote");
const path = require("node:path");
const fs = require("node:fs/promises");
const sync_1 = require("./sync");
const decorations_1 = require("./decorations");
const pyraw_1 = require("./pyraw");
const boardOperations_1 = require("./boardOperations");
// import { monitor } from "./monitor"; // switched to auto-suspend REPL strategy
const mpremoteCommands_1 = require("./mpremoteCommands");
function activate(context) {
    // Check if mpremote is available
    (0, mpremoteCommands_1.checkMpremoteAvailability)().catch(() => { });
    // Helper to get workspace folder or throw error
    function getWorkspaceFolder() {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            throw new Error("No workspace folder open");
        return ws;
    }
    // Helper to get default ignore patterns as Set for compatibility
    function getDefaultIgnoreSet() {
        return new Set((0, sync_1.defaultIgnorePatterns)());
    }
    // Helper to validate if the local folder is initialized
    async function isLocalSyncInitialized() {
        try {
            const ws = getWorkspaceFolder();
            const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
            await fs.access(manifestPath);
            return true;
        }
        catch {
            return false;
        }
    }
    // Helper for delays in retry logic
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    // Workspace-level config and manifest stored in .mpy-workbench/
    const MPY_WORKBENCH_DIR = '.mpy-workbench';
    const MPY_CONFIG_FILE = 'config.json';
    const MPY_MANIFEST_FILE = 'esp32sync.json';
    async function ensureMpyWorkbenchDir(wsPath) {
        try {
            await fs.mkdir(path.join(wsPath, MPY_WORKBENCH_DIR), { recursive: true });
        }
        catch { /* ignore */ }
    }
    async function ensureWorkbenchIgnoreFile(wsPath) {
        try {
            await ensureMpyWorkbenchDir(wsPath);
            const p = path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore');
            await fs.access(p);
        }
        catch {
            const content = buildDefaultMpyIgnoreContent();
            try {
                await fs.writeFile(path.join(wsPath, MPY_WORKBENCH_DIR, '.mpyignore'), content, 'utf8');
            }
            catch { }
        }
    }
    function buildDefaultMpyIgnoreContent() {
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
    async function readWorkspaceConfig(wsPath) {
        try {
            const p = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
            const txt = await fs.readFile(p, 'utf8');
            return JSON.parse(txt);
        }
        catch {
            return {};
        }
    }
    async function writeWorkspaceConfig(wsPath, obj) {
        try {
            await ensureMpyWorkbenchDir(wsPath);
            const p = path.join(wsPath, MPY_WORKBENCH_DIR, MPY_CONFIG_FILE);
            await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
        }
        catch (e) {
            console.error('Failed to write .mpy-workbench config', e);
        }
    }
    // Returns true if autosync should run for this workspace (per-workspace override file wins, otherwise global setting)
    async function workspaceAutoSyncEnabled(wsPath) {
        const cfg = await readWorkspaceConfig(wsPath);
        if (typeof cfg.autoSyncOnSave === 'boolean')
            return cfg.autoSyncOnSave;
        return vscode.workspace.getConfiguration().get('mpyWorkbench.autoSyncOnSave', false);
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
    const localFilesTree = new localFilesView_1.LocalFilesTree();
    const localFilesView = vscode.window.createTreeView("mpyWorkbenchLocalFilesView", { treeDataProvider: localFilesTree });
    const decorations = new decorations_1.Esp32DecorationProvider();
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));
    // Export decorations for use in other modules
    global.esp32Decorations = decorations;
    // Create BoardOperations instance
    const boardOperations = new boardOperations_1.BoardOperations(tree, decorations);
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
        }
        catch (e) {
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
            try {
                return await fn();
            }
            finally { }
        }
        opQueue = opQueue.catch(() => { }).then(async () => {
            const wasOpen = (0, mpremoteCommands_1.isReplOpen)();
            if (wasOpen)
                await (0, mpremoteCommands_1.disconnectReplTerminal)();
            try {
                await ensureIdle();
                return await fn();
            }
            finally {
                if (wasOpen)
                    await (0, mpremoteCommands_1.restartReplInExistingTerminal)();
            }
        });
        return opQueue;
    }
    async function uploadLocalFolderToDevice(localDirPath, deviceBasePath) {
        const folderName = path.basename(localDirPath);
        const deviceDirPath = deviceBasePath === "/" || !deviceBasePath
            ? `/${folderName}`
            : `${deviceBasePath.replace(/\/$/, "")}/${folderName}`;
        try {
            await withAutoSuspend(() => mp.mkdir(deviceDirPath));
        }
        catch (err) {
            const msg = String(err?.message ?? err).toLowerCase();
            if (!msg.includes("file exists") && !msg.includes("directory exists"))
                throw err;
        }
        tree.addNode(deviceDirPath, true);
        const entries = await fs.readdir(localDirPath, { withFileTypes: true });
        for (const e of entries) {
            const entryAbs = path.join(localDirPath, e.name);
            const deviceChildPath = deviceDirPath === "/" ? `/${e.name}` : `${deviceDirPath}/${e.name}`;
            if (e.isDirectory()) {
                await uploadLocalFolderToDevice(entryAbs, deviceDirPath);
            }
            else if (e.isFile()) {
                await withAutoSuspend(() => mp.cpToDevice(entryAbs, deviceChildPath));
                tree.addNode(deviceChildPath, false);
            }
        }
    }
    context.subscriptions.push(view, actionsView, syncView, localFilesView, vscode.commands.registerCommand("mpyWorkbench.refresh", () => {
        // Clear cache and force next listing to come from device
        tree.clearCache();
        tree.enableRawListForNext();
        tree.refreshTree();
    }), vscode.commands.registerCommand("mpyWorkbench.refreshFileTreeCache", async () => {
        try {
            console.log("[DEBUG] Starting manual file tree cache refresh...");
            await mp.refreshFileTreeCache();
            console.log("[DEBUG] File tree cache refresh completed");
            vscode.window.showInformationMessage("File tree cache refreshed successfully");
        }
        catch (error) {
            console.error("[DEBUG] File tree cache refresh failed:", error);
            vscode.window.showErrorMessage(`File tree cache refresh failed: ${error?.message || error}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.initializeWorkspace", async () => {
        try {
            const ws = getWorkspaceFolder();
            const initialized = await isLocalSyncInitialized();
            if (initialized) {
                const choice = await vscode.window.showWarningMessage("De-initialize will remove the .mpy-workbench folder and sync state. Continue?", { modal: true }, "De-initialize", "Cancel");
                if (choice !== "De-initialize")
                    return;
                await fs.rm(path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR), { recursive: true, force: true });
                vscode.window.showInformationMessage("Workspace de-initialized.");
                await refreshAutoSyncStatus();
                syncTree.refreshTree();
                return;
            }
            await ensureMpyWorkbenchDir(ws.uri.fsPath);
            await ensureWorkbenchIgnoreFile(ws.uri.fsPath);
            const emptyManifest = (0, sync_1.createEmptyManifest)(ws.uri.fsPath);
            const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
            await (0, sync_1.saveManifest)(manifestPath, emptyManifest);
            vscode.window.showInformationMessage("Workspace initialized for MPY Workbench.");
            await refreshAutoSyncStatus();
            syncTree.refreshTree();
        }
        catch (e) {
            vscode.window.showErrorMessage(e?.message || "Failed to initialize workspace");
        }
    }), vscode.commands.registerCommand("mpyWorkbench.rebuildManifest", async () => {
        try {
            console.log("[DEBUG] Starting manual manifest rebuild...");
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
            const matcher = await (0, sync_1.createIgnoreMatcher)(ws.uri.fsPath);
            const newManifest = await (0, sync_1.buildManifest)(ws.uri.fsPath, matcher);
            const manifestPath = path.join(ws.uri.fsPath, MPY_WORKBENCH_DIR, MPY_MANIFEST_FILE);
            await (0, sync_1.saveManifest)(manifestPath, newManifest);
            console.log("[DEBUG] Manifest rebuild completed");
            vscode.window.showInformationMessage(`Manifest rebuilt successfully (${Object.keys(newManifest.files).length} files)`);
        }
        catch (error) {
            console.error("[DEBUG] Manifest rebuild failed:", error);
            vscode.window.showErrorMessage(`Manifest rebuild failed: ${error?.message || error}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.debugTreeParsing", async () => {
        try {
            console.log("[DEBUG] Starting tree parsing debug...");
            await (0, mpremote_1.debugTreeParsing)();
            console.log("[DEBUG] Tree parsing debug completed");
            vscode.window.showInformationMessage("Tree parsing debug completed - check console for details");
        }
        catch (error) {
            console.error("[DEBUG] Tree parsing debug failed:", error);
            vscode.window.showErrorMessage(`Tree parsing debug failed: ${error?.message || error}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.debugFilesystemStatus", async () => {
        try {
            console.log("[DEBUG] Starting filesystem status debug...");
            await (0, mpremote_1.debugFilesystemStatus)();
            console.log("[DEBUG] Filesystem status debug completed");
            vscode.window.showInformationMessage("Filesystem status debug completed - check console for details");
        }
        catch (error) {
            console.error("[DEBUG] Filesystem status debug failed:", error);
            vscode.window.showErrorMessage(`Filesystem status debug failed: ${error?.message || error}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.cancelAllTasks", async () => {
        try {
            console.log("[DEBUG] Canceling all tasks...");
            // Cancel current mpremote process
            mp.cancelAll();
            // Clear the operation queue by resetting it
            opQueue = Promise.resolve();
            vscode.window.showInformationMessage("All tasks have been canceled");
            console.log("[DEBUG] All tasks canceled successfully");
        }
        catch (error) {
            console.error("[DEBUG] Failed to cancel tasks:", error);
            vscode.window.showErrorMessage(`Failed to cancel tasks: ${error?.message || error}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.pickPort", async () => {
        // Always get the most recent port list before showing the selector
        const devices = await mp.listSerialPorts();
        const items = [
            { label: "auto", description: "Auto-detect device" },
            ...devices.map(d => ({ label: d.port, description: d.name || "serial port" }))
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select Board serial port" });
        if (!picked)
            return;
        const value = picked.label === "auto" ? "auto" : picked.label;
        await vscode.workspace.getConfiguration().update("mpyWorkbench.connect", value, vscode.ConfigurationTarget.Global);
        updatePortContext();
        vscode.window.showInformationMessage(`Board connect set to ${value}`);
        tree.clearCache();
        tree.refreshTree();
        // (no prompt) just refresh the tree after selecting port
    }), vscode.commands.registerCommand("mpyWorkbench.serialSendCtrlC", mpremoteCommands_1.serialSendCtrlC), vscode.commands.registerCommand("mpyWorkbench.stop", mpremoteCommands_1.stop), vscode.commands.registerCommand("mpyWorkbench.softReset", mpremoteCommands_1.softReset), vscode.commands.registerCommand("mpyWorkbench.uploadToBoard", async (node) => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const devicePath = (0, mpremoteCommands_1.toDevicePath)(node.relPath, rootPath);
        try {
            if (node.kind === "file") {
                await withAutoSuspend(() => mp.cpToDevice(node.fsPath, devicePath));
                tree.addNode(devicePath, false);
                vscode.window.showInformationMessage(`Uploaded to board: ${node.relPath}`);
            }
            else {
                const deviceParent = path.posix.dirname(devicePath);
                await uploadLocalFolderToDevice(node.fsPath, deviceParent);
                vscode.window.showInformationMessage(`Uploaded folder to board: ${node.relPath}`);
            }
            tree.refreshTree();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Upload failed: ${err?.message ?? String(err)}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.setPort", async (port) => {
        await vscode.workspace.getConfiguration().update("mpyWorkbench.connect", port, vscode.ConfigurationTarget.Global);
        updatePortContext();
        vscode.window.showInformationMessage(`ESP32 connect set to ${port}`);
        tree.clearCache();
        tree.refreshTree();
        // (no prompt) just refresh the tree after setting port
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaseline", async () => {
        try {
            // Close the REPL terminal if open to avoid port conflicts
            if ((0, mpremoteCommands_1.isReplOpen)()) {
                await (0, mpremoteCommands_1.disconnectReplTerminal)();
                await new Promise(r => setTimeout(r, 400));
            }
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
            const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
            const matcher2 = await (0, sync_1.createIgnoreMatcher)(ws.uri.fsPath);
            const man = await (0, sync_1.buildManifest)(ws.uri.fsPath, matcher2);
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
                    const allDirectories = new Set();
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
                    let failedDirectories = [];
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
                            }
                            catch (error) {
                                console.log(`[DEBUG] syncBaseline: ✗ Directory ${deviceDir} creation failed (attempt ${attempts}):`, error.message);
                                if (attempts >= maxAttempts) {
                                    failedDirectories.push(deviceDir);
                                    console.error(`[DEBUG] syncBaseline: ✗✗ Giving up on directory ${deviceDir} after ${maxAttempts} attempts`);
                                }
                                else {
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
                    const verificationFailures = [];
                    for (const deviceDir of sortedDirectories) {
                        try {
                            const exists = await mp.fileExists(deviceDir);
                            if (!exists) {
                                console.error(`[DEBUG] syncBaseline: ✗ Directory ${deviceDir} does not exist!`);
                                verificationFailures.push(deviceDir);
                                allDirectoriesExist = false;
                            }
                            else {
                                console.log(`[DEBUG] syncBaseline: ✓ Directory ${deviceDir} verified`);
                            }
                        }
                        catch (error) {
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
                            }
                            catch (createError) {
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
                            }
                            catch (error) {
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
                        }
                        catch (error) {
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
                        vscode.window.showWarningMessage(`Found ${missingFiles.length} files in manifest that don't exist locally. These will be skipped. Consider rebuilding the manifest.`);
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
                        }
                        catch (accessError) {
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
                            // Use cpToDevice which includes directory creation logic
                            console.log(`[DEBUG] syncBaseline: Executing cpToDevice: ${localPath} -> ${devicePath}`);
                            await withAutoSuspend(() => mp.cpToDevice(localPath, devicePath));
                            tree.addNode(devicePath, false); // Add file to tree
                            uploaded++;
                            console.log(`[DEBUG] syncBaseline: ✓ Individual upload ${uploaded}/${actualTotal} successful: ${relativePath}`);
                        }
                        catch (individualError) {
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
            await (0, sync_1.saveManifest)(manifestPath, man);
            console.log(`[DEBUG] syncBaseline: ✓ Manifest saved locally: ${manifestPath}`);
            vscode.window.showInformationMessage("Board: Sync all files (Local → Board) completed");
            // Clear any diff/local-only markers after successful sync-all
            decorations.clear();
            tree.refreshTree();
        }
        catch (error) {
            vscode.window.showErrorMessage(`Upload failed: ${error?.message ?? String(error)}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoard", async () => {
        // Close the REPL terminal if open to avoid port conflicts
        if ((0, mpremoteCommands_1.isReplOpen)()) {
            await (0, mpremoteCommands_1.disconnectReplTerminal)();
            await new Promise(r => setTimeout(r, 400));
        }
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            vscode.window.showErrorMessage("No workspace folder open");
            return;
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const deviceStats = await withAutoSuspend(() => mp.listTreeStats(rootPath));
        const matcher = await (0, sync_1.createIgnoreMatcher)(ws.uri.fsPath);
        const toDownload = deviceStats
            .filter(stat => !stat.isDir)
            .filter(stat => {
            const rel = (0, mpremoteCommands_1.toLocalRelative)(stat.path, rootPath);
            return !matcher(rel, false);
        });
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Board: Sync all files (Board → Local)", cancellable: false }, async (progress) => {
            let done = 0;
            const total = toDownload.length;
            await withAutoSuspend(async () => {
                for (const stat of toDownload) {
                    const rel = (0, mpremoteCommands_1.toLocalRelative)(stat.path, rootPath);
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
    }), vscode.commands.registerCommand("mpyWorkbench.openSerial", mpremoteCommands_1.openReplTerminal), vscode.commands.registerCommand("mpyWorkbench.openRepl", async () => {
        const term = await (0, mpremoteCommands_1.getReplTerminal)(context);
        term.show(true);
    }), vscode.commands.registerCommand("mpyWorkbench.stopSerial", async () => {
        await (0, mpremoteCommands_1.closeReplTerminal)();
        vscode.window.showInformationMessage("Board: ESP32 REPL closed");
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
        if (ws) {
            try {
                const matcher = await (0, sync_1.createIgnoreMatcher)(ws.uri.fsPath);
                const relPosix = rel.replace(/\\\\/g, '/');
                if (matcher(relPosix, false)) {
                    vscode.window.showInformationMessage(`Upload skipped (ignored): ${relPosix}`);
                    return;
                }
            }
            catch { }
        }
        const dest = "/" + rel.replace(/\\\\/g, "/");
        // Use replacing upload to avoid partial writes while code may autostart
        try {
            await withAutoSuspend(() => mp.uploadReplacing(ed.document.uri.fsPath, dest));
            tree.addNode(dest, false);
            vscode.window.showInformationMessage(`Uploaded to ${dest}`);
            tree.refreshTree();
        }
        catch (uploadError) {
            console.error(`[DEBUG] Failed to upload active file to board:`, uploadError);
            vscode.window.showErrorMessage(`Failed to upload active file to board: ${uploadError?.message || uploadError}`);
        }
    }), vscode.commands.registerCommand("mpyWorkbench.runActiveFile", mpremoteCommands_1.runActiveFile), vscode.commands.registerCommand("mpyWorkbench.mkdir", async (node) => {
        const base = node?.kind === "dir" ? node.path : (node ? path.posix.dirname(node.path) : "/");
        const name = await vscode.window.showInputBox({ prompt: "New folder name", validateInput: v => v ? undefined : "Required" });
        if (!name)
            return;
        const target = base === "/" ? `/${name}` : `${base}/${name}`;
        await withAutoSuspend(() => mp.mkdir(target));
        tree.addNode(target, true);
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
                const deletedCount = result.deleted_count ?? result.deleted.length;
                const errorCount = result.error_count ?? result.errors.length;
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
        // Update tree without relisting: leave root directory empty in cache
        tree.resetDir(rootPath);
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
    }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaseline"); }), vscode.commands.registerCommand("mpyWorkbench.syncBaselineFromBoardFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.syncBaselineFromBoard"); }), vscode.commands.registerCommand("mpyWorkbench.runActiveFileFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.runActiveFile"); }), vscode.commands.registerCommand("mpyWorkbench.openReplFromView", async () => { setSkipIdleOnce(); await vscode.commands.executeCommand("mpyWorkbench.openRepl"); }));
    // Auto-upload on save: if file is inside a workspace, push to device path mapped by mpyWorkbench.rootPath
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
        if (!ws)
            return;
        // Only create .mpy-workbench directory if workspace is initialized
        const initialized = await isLocalSyncInitialized();
        if (!initialized)
            return;
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
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const rel = path.relative(ws.uri.fsPath, doc.uri.fsPath).replace(/\\/g, "/");
        try {
            const matcher = await (0, sync_1.createIgnoreMatcher)(ws.uri.fsPath);
            if (matcher(rel, false)) {
                // Skip auto-upload for ignored files
                return;
            }
        }
        catch { }
        const deviceDest = (rootPath === "/" ? "/" : rootPath.replace(/\/$/, "")) + "/" + rel;
        try {
            await withAutoSuspend(() => mp.cpToDevice(doc.uri.fsPath, deviceDest));
            tree.addNode(deviceDest, false);
        }
        catch (e) {
            console.error(`[DEBUG] Auto-upload failed for ${rel}:`, e);
            vscode.window.showWarningMessage(`Board auto-upload failed for ${rel}: ${String(e?.message ?? e)}`);
        }
    }), vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal.name === "ESP32 REPL") {
            // replTerminal is now managed in mpremoteCommands.ts
        }
        (0, mpremoteCommands_1.clearRunFileTerminalIf)(terminal);
    }));
    // Command to toggle workspace-level autosync setting
    context.subscriptions.push(vscode.commands.registerCommand('mpyWorkbench.toggleWorkspaceAutoSync', async () => {
        try {
            const ws = getWorkspaceFolder();
            const cfg = await readWorkspaceConfig(ws.uri.fsPath);
            const current = !!cfg.autoSyncOnSave;
            cfg.autoSyncOnSave = !current;
            await writeWorkspaceConfig(ws.uri.fsPath, cfg);
            vscode.window.showInformationMessage(`Workspace auto-sync on save is now ${cfg.autoSyncOnSave ? 'ENABLED' : 'DISABLED'}`);
            try {
                await refreshAutoSyncStatus();
            }
            catch { }
            setTimeout(() => syncTree.refreshTree(), 0);
        }
        catch (e) {
            vscode.window.showErrorMessage('Failed to toggle workspace auto-sync: ' + String(e));
        }
    }));
}
function deactivate() { }
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
//# sourceMappingURL=extension.js.map