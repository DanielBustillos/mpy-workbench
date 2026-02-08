"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncTree = void 0;
const vscode = require("vscode");
class SyncTree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refreshTree() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) {
        return this.getTreeItemForAction(element);
    }
    async getChildren() {
        return this.getActionNodes();
    }
    getTreeItemForAction(element) {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        if (element.id === "toggleAutoSync") {
            item.command = { command: "mpyWorkbench.toggleWorkspaceAutoSync", title: element.label };
            item.iconPath = new vscode.ThemeIcon("sync");
        }
        else {
            item.command = { command: "mpyWorkbench.runFromView", title: element.label, arguments: [element.command] };
            if (element.id === "initializeWorkspace")
                item.iconPath = new vscode.ThemeIcon("folder-opened");
            if (element.id === "baseline")
                item.iconPath = new vscode.ThemeIcon("cloud-upload");
            if (element.id === "baselineFromBoard")
                item.iconPath = new vscode.ThemeIcon("cloud-download");
            if (element.id === "deleteAllBoard")
                item.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("charts.red"));
        }
        return item;
    }
    async getActionNodes() {
        const fs = require('fs');
        const ws = vscode.workspace.workspaceFolders?.[0];
        const initialized = ws && fs.existsSync(ws.uri.fsPath + '/.mpy-workbench/esp32sync.json');
        const initLabel = initialized ? "De-initialize Workspace" : "Initialize Workspace";
        // Determina el estado actual de autosync para mostrarlo en el label
        let autoSyncLabel = "Autosync: Off";
        try {
            if (ws) {
                const cfg = fs.existsSync(ws.uri.fsPath + '/.mpy-workbench/config.json')
                    ? JSON.parse(fs.readFileSync(ws.uri.fsPath + '/.mpy-workbench/config.json', 'utf8'))
                    : {};
                const enabled = typeof cfg.autoSyncOnSave === 'boolean'
                    ? cfg.autoSyncOnSave
                    : vscode.workspace.getConfiguration().get('mpyWorkbench.autoSyncOnSave', false);
                autoSyncLabel = enabled ? 'Autosync: On' : 'Autosync: Off';
            }
        }
        catch { }
        return [
            { id: "initializeWorkspace", label: initLabel, command: "mpyWorkbench.initializeWorkspace" },
            { id: "toggleAutoSync", label: autoSyncLabel, command: "mpyWorkbench.toggleWorkspaceAutoSync" },
            { id: "baseline", label: "Upload all files (Local → Board)", command: "mpyWorkbench.syncBaseline" },
            { id: "baselineFromBoard", label: "Download all files (Board → Local)", command: "mpyWorkbench.syncBaselineFromBoard" },
            { id: "deleteAllBoard", label: "Clear Device Files", command: "mpyWorkbench.deleteAllBoard" }
        ];
    }
}
exports.SyncTree = SyncTree;
//# sourceMappingURL=syncView.js.map