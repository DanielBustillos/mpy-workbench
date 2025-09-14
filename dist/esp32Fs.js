"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Esp32Tree = void 0;
const vscode = require("vscode");
const mp = require("./mpremote");
const pyraw_1 = require("./pyraw");
const sync_1 = require("./sync");
class Esp32Tree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.rawListOnlyOnce = false;
        // --- Incremental node cache and addNode method ---
        this._nodeCache = new Map();
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
        if (element.isLocalOnly) {
            item.tooltip = '?';
        }
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
    /**
     * Limpia el cache de nodos del árbol (para que desaparezcan los archivos listados).
     */
    clearCache() {
        this._nodeCache.clear();
    }
    /**
     * Agrega un nodo (archivo o carpeta) al árbol en memoria y refresca solo el padre.
     * @param path Ruta absoluta en el board (ej: /foo/bar.txt)
     * @param isDir true si es carpeta, false si es archivo
     */
    addNode(path, isDir) {
        const parentPath = path.includes("/") ? path.replace(/\/[^\/]+$/, "") || "/" : "/";
        const name = path.split("/").pop();
        const node = { kind: isDir ? "dir" : "file", name, path };
        let siblings = this._nodeCache.get(parentPath);
        if (!siblings) {
            siblings = [];
            this._nodeCache.set(parentPath, siblings);
        }
        // Evita duplicados
        if (!siblings.some(n => n.name === name)) {
            siblings.push(node);
            // Ordena: carpetas primero, luego archivos, ambos alfabéticamente
            siblings.sort((a, b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
        }
        // Refresca árbol (VS Code volverá a pedir getChildren; usaremos cache)
        this._onDidChangeTreeData.fire(undefined);
    }
    /** Elimina un nodo del árbol en memoria y refresca la vista. */
    removeNode(path) {
        const parentPath = path.includes("/") ? path.replace(/\/[^\/]+$/, "") || "/" : "/";
        const name = path.split("/").pop();
        const siblings = this._nodeCache.get(parentPath);
        if (siblings) {
            const idx = siblings.findIndex(n => n.name === name);
            if (idx >= 0)
                siblings.splice(idx, 1);
        }
        // Si era carpeta, limpia su cache
        this._nodeCache.delete(path);
        this._onDidChangeTreeData.fire(undefined);
    }
    /** Deja una carpeta en blanco en cache (útil tras borrar todo un directorio). */
    resetDir(path) {
        this._nodeCache.set(path, []);
        this._onDidChangeTreeData.fire(undefined);
    }
    // Modifica getChildNodes para usar el cache si existe
    async getChildNodes(element) {
        const port = vscode.workspace.getConfiguration().get("mpyWorkbench.connect", "auto");
        if (!port || port === "" || port === "auto") {
            return [];
        }
        const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
        const path = element?.path ?? rootPath;
        // Permite forzar re-listado una vez (desde el botón Refresh)
        const forceList = this.rawListOnlyOnce;
        this.rawListOnlyOnce = false;
        // Si hay cache para este path y no se fuerza re-listado, úsalo
        if (!forceList && this._nodeCache.has(path)) {
            return this._nodeCache.get(path);
        }
        try {
            let entries;
            const usePyRaw = vscode.workspace.getConfiguration().get("mpyWorkbench.usePyRawList", false);
            entries = await vscode.commands.executeCommand("mpyWorkbench.autoSuspendLs", path);
            if (!entries) {
                entries = usePyRaw ? await (0, pyraw_1.listDirPyRaw)(path) : await mp.lsTyped(path);
            }
            // Create nodes from board files
            const nodes = entries.map(e => {
                const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
                return { kind: e.isDir ? "dir" : "file", name: e.name, path: childPath };
            });
            // Apply ignore rules (from workspace .mpyignore and .mpy-workbench/.mpyignore)
            try {
                const ws = vscode.workspace.workspaceFolders?.[0];
                if (ws) {
                    const matcher = await (0, sync_1.createIgnoreMatcher)(ws.uri.fsPath);
                    const rootPath = vscode.workspace.getConfiguration().get("mpyWorkbench.rootPath", "/");
                    const filtered = nodes.filter(n => {
                        const isDir = n.kind === 'dir';
                        // Convert device path to local-relative path for matching
                        const normRoot = rootPath === '/' ? '/' : rootPath.replace(/\/$/, '');
                        let rel;
                        if (normRoot === '/')
                            rel = n.path.replace(/^\//, '');
                        else if (n.path.startsWith(normRoot + '/'))
                            rel = n.path.slice(normRoot.length + 1);
                        else if (n.path === normRoot)
                            rel = '';
                        else
                            rel = n.path.replace(/^\//, '');
                        return !matcher(rel, isDir);
                    });
                    nodes.length = 0;
                    nodes.push(...filtered);
                }
            }
            catch { }
            // Add local-only files and directories to the tree view
            try {
                const ws = vscode.workspace.workspaceFolders?.[0];
                if (ws) {
                    // Access decorations via global reference
                    const decorations = global.esp32Decorations;
                    if (decorations) {
                        const localOnlyFiles = decorations.getLocalOnly();
                        const currentPathPrefix = path === "/" ? "/" : path + "/";
                        // Collect direct children that should be added
                        const itemsToAdd = new Map();
                        // Find local-only files that should appear in this directory
                        for (const localOnlyPath of localOnlyFiles) {
                            if (localOnlyPath.startsWith(currentPathPrefix)) {
                                const remainingPath = localOnlyPath.slice(currentPathPrefix.length);
                                // Only process direct children (no deeper nested paths)
                                if (remainingPath && !remainingPath.includes('/')) {
                                    // Check if this item is not already in the board entries
                                    const alreadyExists = nodes.some(n => n.name === remainingPath);
                                    if (!alreadyExists) {
                                        itemsToAdd.set(remainingPath, { path: localOnlyPath, isDir: false });
                                    }
                                }
                                else if (remainingPath && remainingPath.includes('/')) {
                                    // This is a nested path - we need to add the parent directory
                                    const parentDir = remainingPath.split('/')[0];
                                    const parentPath = currentPathPrefix + parentDir;
                                    if (!itemsToAdd.has(parentDir) && !nodes.some(n => n.name === parentDir)) {
                                        itemsToAdd.set(parentDir, { path: parentPath, isDir: true });
                                    }
                                }
                            }
                        }
                        // Add the collected items to nodes
                        for (const [name, item] of itemsToAdd) {
                            nodes.push({
                                kind: item.isDir ? "dir" : "file",
                                name: name,
                                path: item.path,
                                isLocalOnly: true
                            });
                        }
                    }
                }
            }
            catch (err) {
                // Silently ignore errors when adding local-only files
                console.log("Could not add local-only files to tree:", err);
            }
            nodes.sort((a, b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
            // Cachear este directorio para actualizaciones incrementales
            this._nodeCache.set(path, nodes);
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