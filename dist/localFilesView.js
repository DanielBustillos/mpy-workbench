"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalFilesTree = void 0;
const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs/promises");
/** Default folder names to hide from the local tree (like Explorer). */
const DEFAULT_HIDDEN = new Set([
    ".git",
    ".mpy-workbench",
    "node_modules",
    "__pycache__",
    ".vscode",
    ".idea",
]);
class LocalFilesTree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refreshTree() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.name, element.kind === "dir"
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        item.contextValue = element.kind;
        item.resourceUri = vscode.Uri.file(element.fsPath);
        item.iconPath = element.kind === "dir"
            ? new vscode.ThemeIcon("folder")
            : new vscode.ThemeIcon("file");
        if (element.kind === "file") {
            item.command = {
                command: "vscode.open",
                title: "Open",
                arguments: [item.resourceUri],
            };
        }
        return item;
    }
    async getChildren(element) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            return [];
        const basePath = element ? element.fsPath : ws.uri.fsPath;
        const relBase = element ? element.relPath : "";
        try {
            const entries = await fs.readdir(basePath, { withFileTypes: true });
            const nodes = [];
            for (const e of entries) {
                if (!element && DEFAULT_HIDDEN.has(e.name))
                    continue;
                const rel = relBase ? `${relBase}/${e.name}` : e.name;
                const abs = path.join(basePath, e.name);
                const kind = e.isDirectory() ? "dir" : "file";
                nodes.push({ kind, name: e.name, relPath: rel, fsPath: abs });
            }
            nodes.sort((a, b) => {
                if (a.kind !== b.kind)
                    return a.kind === "dir" ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
            });
            return nodes;
        }
        catch {
            return [];
        }
    }
    getParent(element) {
        if (!element.relPath)
            return undefined;
        const parentRel = path.posix.dirname(element.relPath);
        if (parentRel === "." || parentRel === element.relPath)
            return undefined;
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws)
            return undefined;
        const parentFsPath = path.join(ws.uri.fsPath, ...parentRel.split("/"));
        const name = path.posix.basename(parentRel);
        return { kind: "dir", name, relPath: parentRel, fsPath: parentFsPath };
    }
}
exports.LocalFilesTree = LocalFilesTree;
//# sourceMappingURL=localFilesView.js.map