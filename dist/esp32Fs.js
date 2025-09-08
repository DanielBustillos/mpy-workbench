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
    refresh() { this._onDidChangeTreeData.fire(); }
    // When set, the next getChildren call will list directly,
    // skipping any auto-suspend/handshake commands.
    setRawListOnlyOnce() { this.rawListOnlyOnce = true; }
    getTreeItem(element) {
        if (element === "no-port") {
            const item = new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None);
            item.description = "";
            item.command = {
                command: "esp32fs.pickPort",
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
                command: "esp32fs.openFile",
                title: "Open",
                arguments: [element]
            };
        return item;
    }
    async getChildren(element) {
        const port = vscode.workspace.getConfiguration().get("esp32fs.connect", "auto");
        if (!port || port === "" || port === "auto") {
            // Return empty to trigger the view's welcome content with a button
            return [];
        }
        const rootPath = vscode.workspace.getConfiguration().get("esp32fs.rootPath", "/");
        const path = element?.path ?? rootPath;
        try {
            let entries;
            const usePyRaw = vscode.workspace.getConfiguration().get("esp32fs.usePyRawList", false);
            // Siempre listar pasando por autoSuspend para evitar conflictos con la terminal REPL
            // Incluso si 'rawListOnlyOnce' estaba activo, no saltamos el auto-suspend para evitar que se "filtre" en miniterm
            this.rawListOnlyOnce = false;
            entries = await vscode.commands.executeCommand("esp32fs.autoSuspendLs", path);
            if (!entries) {
                // Fallback defensivo, igualmente con auto-suspend implícito vía comando ya usado
                entries = usePyRaw ? await (0, pyraw_1.listDirPyRaw)(path) : await mp.lsTyped(path);
            }
            const nodes = entries.map(e => {
                const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
                return { kind: e.isDir ? "dir" : "file", name: e.name, path: childPath };
            });
            nodes.sort((a, b) => (a.kind === b.kind) ? a.name.localeCompare(b.name) : (a.kind === "dir" ? -1 : 1));
            return nodes;
        }
        catch (err) {
            vscode.window.showErrorMessage(`ESP32 list error at ${path}: ${err?.message ?? String(err)}`);
            return [];
        }
    }
    icon(file) {
        return vscode.Uri.joinPath(this.extUri(), "media", file);
    }
    extUri() {
        return vscode.extensions.getExtension("your-name.esp32-files-explorer").extensionUri;
    }
}
exports.Esp32Tree = Esp32Tree;
//# sourceMappingURL=esp32Fs.js.map