"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncTree = void 0;
const vscode = require("vscode");
class SyncTree {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.command = { command: "mpyWorkbench.runFromView", title: element.label, arguments: [element.command] };
        if (element.id === "baseline")
            item.iconPath = new vscode.ThemeIcon("cloud-upload");
        if (element.id === "baselineFromBoard")
            item.iconPath = new vscode.ThemeIcon("cloud-download");
        if (element.id === "checkDiffs")
            item.iconPath = new vscode.ThemeIcon("diff");
        if (element.id === "syncDiffsLocalToBoard")
            item.iconPath = new vscode.ThemeIcon("cloud-upload");
        if (element.id === "syncDiffsBoardToLocal")
            item.iconPath = new vscode.ThemeIcon("cloud-download");
        return item;
    }
    async getChildren() {
        return [
            { id: "baseline", label: "Sync all files (Local → Board)", command: "mpyWorkbench.syncBaseline" },
            { id: "baselineFromBoard", label: "Sync all files (Board → Local)", command: "mpyWorkbench.syncBaselineFromBoard" },
            { id: "checkDiffs", label: "Check files differences", command: "mpyWorkbench.checkDiffs" },
            { id: "syncDiffsLocalToBoard", label: "Sync changed Files Local → Board", command: "mpyWorkbench.syncDiffsLocalToBoard" },
            { id: "syncDiffsBoardToLocal", label: "Sync changed Files Board → Local", command: "mpyWorkbench.syncDiffsBoardToLocal" }
        ];
    }
}
exports.SyncTree = SyncTree;
//# sourceMappingURL=syncView.js.map