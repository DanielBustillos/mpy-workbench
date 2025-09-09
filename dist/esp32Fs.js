"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Esp32Tree = void 0;
const vscode = require("vscode");
const mp = require("./mpremote");
const pyraw_1 = require("./pyraw");
class Esp32Tree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.rawListOnlyOnce = false;
    }
    refreshTree() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) {
        return this.getTreeItemForNode(element);
    }
    getChildren(element) {
        return Promise.resolve(this.getChildNodes(element));
    }
    // When set, the next getChildren call will list directly,
    // skipping any auto-suspend/handshake commands.
    enableRawListForNext() { this.rawListOnlyOnce = true; }
    getTreeItemForNode(element) {
        if (element === "no-port") {
            const item = new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None);
            item.command = {
                command: "mpyWorkbench.pickPort",
                title: "Select Port"
            };
            // Usar el estilo de welcome view para el botón
            item.tooltip = "Click to select a serial port";
            item.label = "$(plug) Select Serial Port";
            // Aplicar la clase CSS personalizada
            item.className = 'esp32fs-no-port-item';
            return item;
        }
        const item = new vscode.TreeItem(element.name, element.kind === "dir" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.contextValue = element.kind; // for menus
        item.resourceUri = vscode.Uri.parse(`esp32:${element.path}`);
        item.iconPath = element.kind === "dir"
            ? { light: this.icon("folder.svg"), dark: this.icon("folder.svg") }
            : { light: this.icon("file.svg"), dark: this.icon("file.svg") };
        if (element.kind === "file")
            item.command = {
                command: "mpyWorkbench.openFile",
                title: "Open",
                arguments: [element]
            };
        return item;
    }
    async getChildNodes(element) {
        const port = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
        if (!port || port === "" || port === "auto") {
            // No error: just return empty to trigger the view's welcome content with a button
            return [];
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const path = element?.path ?? rootPath;
        try {
            let entries;
            const usePyRaw = vscode.workspace.getConfiguration().get("mpyWorkbench.usePyRawList", false);
            this.rawListOnlyOnce = false;
            entries = await vscode.commands.executeCommand("mpyWorkbench.autoSuspendLs", path);
            if (!entries) {
                entries = usePyRaw ? await (0, pyraw_1.listDirPyRaw)(path) : await mp.lsTyped(path);
            }
            // Create nodes from board files
            const nodes = entries.map(e => {
                const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
                return { kind: e.isDir ? "dir" : "file", name: e.name, path: childPath };
            });
            // Add local-only files to the tree view
            try {
                const ws = vscode.workspace.workspaceFolders?.[0];
                if (ws) {
                    // Access decorations via global reference
                    const decorations = global.esp32Decorations;
                    if (decorations) {
                        const localOnlyFiles = decorations.getLocalOnly();
                        const currentPathPrefix = path === "/" ? "/" : path + "/";
                        // Find local-only files that should appear in this directory
                        for (const localOnlyPath of localOnlyFiles) {
                            if (localOnlyPath.startsWith(currentPathPrefix)) {
                                const remainingPath = localOnlyPath.slice(currentPathPrefix.length);
                                // Only add direct children (no deeper nested paths)
                                if (remainingPath && !remainingPath.includes('/')) {
                                    // Check if this file/dir is not already in the board entries
                                    const alreadyExists = nodes.some(n => n.name === remainingPath);
                                    if (!alreadyExists) {
                                        // For now, assume local-only items are files (we could check the filesystem for more accuracy)
                                        nodes.push({
                                            kind: "file",
                                            name: remainingPath,
                                            path: localOnlyPath,
                                            isLocalOnly: true
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch (err) {
                // Silently ignore errors when adding local-only files
                console.log("Could not add local-only files to tree:", err);
            }
            nodes.sort((a, b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
            return nodes;
        }
        catch (err) {
            // Only show error if it's not a "no port selected" issue
            const errorMessage = String(err?.message ?? err).toLowerCase();
            const isPortError = errorMessage.includes("select a specific serial port") ||
                errorMessage.includes("serial port") ||
                errorMessage.includes("auto");
            if (!isPortError && port && port !== "" && port !== "auto") {
                vscode.window.showErrorMessage(`ESP32 list error at ${path}: ${err?.message ?? String(err)}`);
            }
            return [];
        }
    }
    icon(file) {
        return vscode.Uri.joinPath(this.extUri(), "media", file);
    }
    extUri() {
        // Use the actual publisher.name from package.json
        return vscode.extensions.getExtension("DanielBucam.mpy-workbench").extensionUri;
    }
}
exports.Esp32Tree = Esp32Tree;
//# sourceMappingURL=esp32Fs.js.map